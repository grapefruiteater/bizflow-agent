[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$AWS_PROFILE,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$AWS_REGION,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [ValidateLength(1, 5000)]
    [string]$ModelId,

    [string]$ConfigPath,

    [string]$StackName,

    [switch]$EnableReadTools,

    [string]$ToolsConfigPath,

    [switch]$Execute,

    [ValidateRange(60, 3600)]
    [int]$TimeoutSeconds = 900,

    [ValidateRange(2, 60)]
    [int]$PollIntervalSeconds = 10,

    [string]$DeploymentRecordDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Assert-CommandExists {
    param([Parameter(Mandatory = $true)][string]$Name)

    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required command '$Name' was not found in PATH."
    }
}

function Format-CommandArgument {
    param([Parameter(Mandatory = $true)][string]$Value)

    if ($Value -match '[\s"]') {
        return '"' + $Value.Replace('"', '\"') + '"'
    }
    return $Value
}

function Write-NativeCommand {
    param(
        [Parameter(Mandatory = $true)][string]$Command,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    $formatted = @($Command) + @($Arguments | ForEach-Object { Format-CommandArgument $_ })
    Write-Host ("> " + ($formatted -join " ")) -ForegroundColor DarkGray
}

function Invoke-NativeText {
    param(
        [Parameter(Mandatory = $true)][string]$Command,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [switch]$Sensitive
    )

    if (-not $Sensitive) {
        Write-NativeCommand -Command $Command -Arguments $Arguments
    }

    # BuildKit and some other native tools write normal progress to stderr.
    # With ErrorActionPreference=Stop, PowerShell can otherwise turn the first
    # progress line into a terminating ErrorRecord before the process finishes.
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        $outputLines = @(& $Command @Arguments 2>&1)
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    $text = ($outputLines | ForEach-Object {
        if ($_ -is [System.Management.Automation.ErrorRecord]) {
            $_.Exception.Message
        }
        else {
            $_.ToString()
        }
    }) -join [Environment]::NewLine
    if ($exitCode -ne 0) {
        throw "Command failed with exit code ${exitCode}: $Command`n$text"
    }
    return $text.Trim()
}

function Get-AwsBaseArguments {
    return @(
        "--profile", $AWS_PROFILE,
        "--region", $AWS_REGION,
        "--no-cli-pager"
    )
}

function Invoke-AwsJson {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)

    $allArguments = @($Arguments) + @(Get-AwsBaseArguments) + @("--output", "json")
    $json = Invoke-NativeText -Command "aws" -Arguments $allArguments
    try {
        return $json | ConvertFrom-Json
    }
    catch {
        throw "AWS CLI did not return valid JSON.`n$json"
    }
}

function Invoke-AwsText {
    param(
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [switch]$Sensitive
    )

    $allArguments = @($Arguments) + @(Get-AwsBaseArguments) + @("--output", "text")
    return Invoke-NativeText -Command "aws" -Arguments $allArguments -Sensitive:$Sensitive
}

function Get-PropertyValue {
    param(
        [Parameter(Mandatory = $true)][object]$Object,
        [Parameter(Mandatory = $true)][string[]]$Names,
        [switch]$Optional
    )

    foreach ($name in $Names) {
        $property = $Object.PSObject.Properties[$name]
        if ($null -ne $property -and $null -ne $property.Value -and "$($property.Value)".Length -gt 0) {
            return $property.Value
        }
    }

    if ($Optional) {
        return $null
    }
    throw "Configuration is missing required value. Accepted keys: $($Names -join ', ')"
}

function Select-ConfigurationObject {
    param(
        [Parameter(Mandatory = $true)][object]$Root,
        [string]$RequestedStackName
    )

    if ($null -ne $Root.PSObject.Properties["AgentRuntimeId"]) {
        return $Root
    }

    if ($RequestedStackName) {
        $stackProperty = $Root.PSObject.Properties[$RequestedStackName]
        if ($null -eq $stackProperty) {
            throw "Stack '$RequestedStackName' was not found in the CDK outputs file."
        }
        return $stackProperty.Value
    }

    $candidates = @(
        $Root.PSObject.Properties |
            Where-Object { $null -ne $_.Value.PSObject.Properties["AgentRuntimeId"] }
    )
    if ($candidates.Count -ne 1) {
        throw "Could not choose one CDK stack output. Specify -StackName or use the normalized configuration format."
    }
    return $candidates[0].Value
}

function Read-DeploymentConfiguration {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [string]$RequestedStackName
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Configuration file was not found: $Path"
    }

    try {
        $root = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
    }
    catch {
        throw "Configuration file is not valid JSON: $Path"
    }

    $values = Select-ConfigurationObject -Root $root -RequestedStackName $RequestedStackName
    $networkValue = Get-PropertyValue -Object $values -Names @(
        "AgentRuntimeNetworkConfiguration",
        "NetworkConfiguration"
    )
    if ($networkValue -is [string]) {
        try {
            $networkValue = $networkValue | ConvertFrom-Json
        }
        catch {
            throw "AgentRuntimeNetworkConfiguration must be a JSON object or a JSON-encoded string."
        }
    }

    $networkMode = Get-PropertyValue -Object $networkValue -Names @("networkMode")
    if ($networkMode -notin @("PUBLIC", "VPC")) {
        throw "networkMode must be PUBLIC or VPC."
    }
    if ($networkMode -eq "VPC") {
        $networkModeConfig = Get-PropertyValue -Object $networkValue -Names @("networkModeConfig")
        [void](Get-PropertyValue -Object $networkModeConfig -Names @("securityGroups"))
        [void](Get-PropertyValue -Object $networkModeConfig -Names @("subnets"))
    }

    $endpointName = Get-PropertyValue -Object $values -Names @(
        "AgentRuntimeEndpointName",
        "EndpointName"
    )

    return [pscustomobject]@{
        EcrRepositoryUri = [string](Get-PropertyValue -Object $values -Names @(
            "EcrRepositoryUri",
            "AgentEcrRepositoryUri"
        ))
        AgentRuntimeId = [string](Get-PropertyValue -Object $values -Names @("AgentRuntimeId"))
        AgentRuntimeArn = [string](Get-PropertyValue -Object $values -Names @("AgentRuntimeArn"))
        RoleArn = [string](Get-PropertyValue -Object $values -Names @(
            "AgentRuntimeExecutionRoleArn",
            "AgentRuntimeRoleArn",
            "RoleArn"
        ))
        NetworkConfiguration = $networkValue
        EndpointName = [string]$endpointName
    }
}

function Read-ToolsGatewayUrl {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Tools Outputs file was not found: $Path"
    }
    try {
        $root = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
    }
    catch {
        throw "Tools Outputs file is not valid JSON: $Path"
    }

    $directProperty = $root.PSObject.Properties["BusinessToolsGatewayUrl"]
    if ($null -ne $directProperty -and $directProperty.Value) {
        return [string]$directProperty.Value
    }
    $candidates = @(
        $root.PSObject.Properties |
            ForEach-Object {
                $gatewayProperty = $_.Value.PSObject.Properties["BusinessToolsGatewayUrl"]
                if ($null -ne $gatewayProperty -and $gatewayProperty.Value) {
                    [string]$gatewayProperty.Value
                }
            }
    )
    if ($candidates.Count -ne 1) {
        throw "Could not find one BusinessToolsGatewayUrl in the Tools Outputs file."
    }
    return $candidates[0]
}

function Get-EcrDetails {
    param([Parameter(Mandatory = $true)][string]$RepositoryUri)

    $pattern = '^(?<account>\d{12})\.dkr\.ecr\.(?<region>[a-z0-9-]+)\.amazonaws\.com(?:\.cn)?/(?<repository>[a-z0-9]+(?:[._/-][a-z0-9]+)*)$'
    $match = [regex]::Match($RepositoryUri, $pattern)
    if (-not $match.Success) {
        throw "EcrRepositoryUri must be a private ECR repository URI without a tag: $RepositoryUri"
    }

    return [pscustomobject]@{
        AccountId = $match.Groups["account"].Value
        Region = $match.Groups["region"].Value
        RepositoryName = $match.Groups["repository"].Value
        Registry = $RepositoryUri.Substring(0, $RepositoryUri.IndexOf('/'))
    }
}

function Wait-AgentRuntimeReady {
    param(
        [Parameter(Mandatory = $true)][string]$AgentRuntimeId,
        [Parameter(Mandatory = $true)][string]$AgentRuntimeVersion
    )

    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTimeOffset]::UtcNow -lt $deadline) {
        $runtime = Invoke-AwsJson -Arguments @(
            "bedrock-agentcore-control", "get-agent-runtime",
            "--agent-runtime-id", $AgentRuntimeId,
            "--agent-runtime-version", $AgentRuntimeVersion
        )
        $runtimeStatus = [string](Get-PropertyValue -Object $runtime -Names @("status"))
        Write-Host "Runtime version $AgentRuntimeVersion status: $runtimeStatus"
        if ($runtimeStatus -eq "READY") {
            return $runtime
        }
        if ($runtimeStatus -in @("CREATE_FAILED", "UPDATE_FAILED", "DELETING")) {
            $failureReason = [string](Get-PropertyValue -Object $runtime -Names @("failureReason") -Optional)
            throw "Runtime version $AgentRuntimeVersion entered ${runtimeStatus}: $failureReason"
        }
        Start-Sleep -Seconds $PollIntervalSeconds
    }
    throw "Timed out waiting for Runtime version $AgentRuntimeVersion to become READY."
}

function Get-AgentRuntimeEndpoint {
    param(
        [Parameter(Mandatory = $true)][string]$AgentRuntimeId,
        [Parameter(Mandatory = $true)][string]$EndpointName
    )

    return Invoke-AwsJson -Arguments @(
        "bedrock-agentcore-control", "get-agent-runtime-endpoint",
        "--agent-runtime-id", $AgentRuntimeId,
        "--endpoint-name", $EndpointName
    )
}

function Wait-AgentRuntimeEndpointReady {
    param(
        [Parameter(Mandatory = $true)][string]$AgentRuntimeId,
        [Parameter(Mandatory = $true)][string]$EndpointName,
        [Parameter(Mandatory = $true)][string]$ExpectedVersion
    )

    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTimeOffset]::UtcNow -lt $deadline) {
        $endpoint = Get-AgentRuntimeEndpoint -AgentRuntimeId $AgentRuntimeId -EndpointName $EndpointName
        $endpointStatus = [string](Get-PropertyValue -Object $endpoint -Names @("status"))
        $liveVersion = [string](Get-PropertyValue -Object $endpoint -Names @("liveVersion") -Optional)
        $targetVersion = [string](Get-PropertyValue -Object $endpoint -Names @("targetVersion") -Optional)
        $liveVersionDisplay = if ($liveVersion) { $liveVersion } else { "not-reported" }
        $targetVersionDisplay = if ($targetVersion) { $targetVersion } else { "not-reported" }
        Write-Host "Endpoint $EndpointName status: $endpointStatus, liveVersion: $liveVersionDisplay, targetVersion: $targetVersionDisplay"
        if ($endpointStatus -eq "READY" -and $liveVersion -eq $ExpectedVersion) {
            return $endpoint
        }
        if ($endpointStatus -in @("CREATE_FAILED", "UPDATE_FAILED", "DELETING")) {
            $failureReason = [string](Get-PropertyValue -Object $endpoint -Names @("failureReason") -Optional)
            throw "Endpoint $EndpointName entered ${endpointStatus}: $failureReason"
        }
        Start-Sleep -Seconds $PollIntervalSeconds
    }
    throw "Timed out waiting for endpoint $EndpointName to serve Runtime version $ExpectedVersion."
}

function Write-DeploymentRecord {
    param(
        [Parameter(Mandatory = $true)][object]$Record,
        [Parameter(Mandatory = $true)][string]$Directory,
        [Parameter(Mandatory = $true)][string]$FileName
    )

    [void](New-Item -ItemType Directory -Path $Directory -Force)
    $recordPath = Join-Path $Directory $FileName
    $Record.updatedAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
    $Record | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $recordPath -Encoding UTF8
    return $recordPath
}

function New-RollbackCommand {
    param(
        [Parameter(Mandatory = $true)][string]$AgentRuntimeId,
        [Parameter(Mandatory = $true)][string]$EndpointName,
        [Parameter(Mandatory = $true)][string]$PreviousVersion
    )

    return "aws bedrock-agentcore-control update-agent-runtime-endpoint --agent-runtime-id `"$AgentRuntimeId`" --endpoint-name `"$EndpointName`" --agent-runtime-version `"$PreviousVersion`" --profile `"$AWS_PROFILE`" --region `"$AWS_REGION`" --no-cli-pager"
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if (-not $ConfigPath) {
    $ConfigPath = Join-Path $repoRoot "config\cdk-outputs.json"
}
elseif (-not [IO.Path]::IsPathRooted($ConfigPath)) {
    $ConfigPath = Join-Path $repoRoot $ConfigPath
}
if (-not $DeploymentRecordDirectory) {
    $DeploymentRecordDirectory = Join-Path $repoRoot "deployments\agentcore"
}
elseif (-not [IO.Path]::IsPathRooted($DeploymentRecordDirectory)) {
    $DeploymentRecordDirectory = Join-Path $repoRoot $DeploymentRecordDirectory
}

$gatewayUrl = $null
if ($EnableReadTools) {
    if (-not $ToolsConfigPath) {
        $ToolsConfigPath = Join-Path $repoRoot "config\tools-outputs.json"
    }
    elseif (-not [IO.Path]::IsPathRooted($ToolsConfigPath)) {
        $ToolsConfigPath = Join-Path $repoRoot $ToolsConfigPath
    }
    $gatewayUrl = Read-ToolsGatewayUrl -Path $ToolsConfigPath
    $escapedRegion = [regex]::Escape($AWS_REGION)
    $gatewayPattern = "^https://[a-zA-Z0-9-]+\.gateway\.bedrock-agentcore\.${escapedRegion}\.amazonaws\.com(?:\.cn)?/mcp/?$"
    if ($gatewayUrl -notmatch $gatewayPattern) {
        throw "BusinessToolsGatewayUrl must be the regional HTTPS AgentCore Gateway /mcp endpoint for $AWS_REGION."
    }
    $gatewayUrl = $gatewayUrl.TrimEnd('/')
}

Assert-CommandExists -Name "aws"
Assert-CommandExists -Name "git"
Assert-CommandExists -Name "docker"

$configuration = Read-DeploymentConfiguration -Path $ConfigPath -RequestedStackName $StackName
$ecr = Get-EcrDetails -RepositoryUri $configuration.EcrRepositoryUri

if ($configuration.EndpointName -ieq "DEFAULT") {
    $defaultEndpointMessage = "AgentCore automatically moves the DEFAULT endpoint when UpdateAgentRuntime creates a new version. The required manual approval before traffic promotion cannot be enforced with DEFAULT. Configure a custom endpoint such as PROD before executable publishing."
    if ($Execute) {
        throw $defaultEndpointMessage
    }
    Write-Warning $defaultEndpointMessage
}

$gitRoot = Invoke-NativeText -Command "git" -Arguments @("-C", $repoRoot, "rev-parse", "--show-toplevel")
if ((Resolve-Path $gitRoot).Path -ne $repoRoot) {
    throw "The script must be run from the BizFlow Agent Git repository. Resolved root: $gitRoot"
}
$gitStatus = Invoke-NativeText -Command "git" -Arguments @("-C", $repoRoot, "status", "--porcelain")
if ($gitStatus) {
    throw "The Git worktree is not clean. Commit the exact content before publishing so the image tag remains traceable."
}
$gitCommit = (Invoke-NativeText -Command "git" -Arguments @("-C", $repoRoot, "rev-parse", "HEAD")).ToLowerInvariant()
if ($gitCommit -notmatch '^[0-9a-f]{40}$') {
    throw "Git did not return a full 40-character commit SHA."
}
$imageTag = $gitCommit
$imageUri = "$($configuration.EcrRepositoryUri):$imageTag"

$identity = Invoke-AwsJson -Arguments @("sts", "get-caller-identity")
Write-Host "AWS connection target" -ForegroundColor Cyan
Write-Host "  Account: $($identity.Account)"
Write-Host "  ARN:     $($identity.Arn)"
Write-Host "  Region:  $AWS_REGION"
if ($identity.Arn -match '^arn:aws(?:-[a-z]+)*:iam::\d{12}:root$') {
    throw "Publishing as the AWS account root user is prohibited. Use an IAM Identity Center SSO profile."
}
if ([string]$identity.Account -ne $ecr.AccountId) {
    throw "Connected account $($identity.Account) does not match ECR account $($ecr.AccountId)."
}
if ($AWS_REGION -ne $ecr.Region) {
    throw "AWS_REGION '$AWS_REGION' does not match ECR region '$($ecr.Region)'."
}

$repositoryResult = Invoke-AwsJson -Arguments @(
    "ecr", "describe-repositories",
    "--repository-names", $ecr.RepositoryName
)
$repositories = @($repositoryResult.repositories)
if ($repositories.Count -ne 1) {
    throw "Expected one ECR repository but received $($repositories.Count): $($ecr.RepositoryName)"
}
$repository = $repositories[0]
if ([string]$repository.imageTagMutability -ne "IMMUTABLE") {
    throw "ECR repository must use imageTagMutability=IMMUTABLE. Current value: $($repository.imageTagMutability)"
}
if (-not [bool]$repository.imageScanningConfiguration.scanOnPush) {
    throw "ECR repository must have scanOnPush enabled."
}
Write-Host "  ECR tags: IMMUTABLE"
Write-Host "  ECR scan: scan-on-push enabled"

$existingImageResult = Invoke-AwsJson -Arguments @(
    "ecr", "batch-get-image",
    "--repository-name", $ecr.RepositoryName,
    "--image-ids", "imageTag=$imageTag"
)
$existingImages = @($existingImageResult.images)
if ($existingImages.Count -gt 1) {
    throw "ECR returned more than one image for tag '$imageTag'."
}
$unexpectedImageFailures = @(
    @($existingImageResult.failures) |
        Where-Object { [string]$_.failureCode -ne "ImageNotFound" }
)
if ($unexpectedImageFailures.Count -gt 0) {
    $failureCodes = @($unexpectedImageFailures | ForEach-Object { [string]$_.failureCode }) -join ", "
    throw "ECR batch-get-image failed for tag '$imageTag': $failureCodes"
}
$existingImage = if ($existingImages.Count -eq 1) { $existingImages[0] } else { $null }
$existingImageDigest = $null
if ($null -ne $existingImage) {
    $existingImageDigest = [string]$existingImage.imageId.imageDigest
}

$agentDirectory = Join-Path $repoRoot "agents\bizflow"
$dockerfilePath = Join-Path $agentDirectory "Dockerfile"
if (-not (Test-Path -LiteralPath $dockerfilePath -PathType Leaf)) {
    throw "Dockerfile was not found: $dockerfilePath"
}

Write-Host ""
Write-Host "Publish inputs" -ForegroundColor Cyan
Write-Host "  Git commit:       $gitCommit"
Write-Host "  Image URI:        $imageUri"
Write-Host "  Runtime ID:       $($configuration.AgentRuntimeId)"
Write-Host "  Endpoint:         $($configuration.EndpointName)"
Write-Host "  Bedrock model:    $ModelId"
Write-Host "  Network mode:     $($configuration.NetworkConfiguration.networkMode)"
Write-Host "  Config:           $ConfigPath"
Write-Host "  Read tools:       $([bool]$EnableReadTools)"
if ($gatewayUrl) {
    Write-Host "  Gateway:          $gatewayUrl"
    Write-Host "  Tools config:     $ToolsConfigPath"
}
if ($existingImageDigest) {
    Write-Host "  Existing digest:  $existingImageDigest" -ForegroundColor Yellow
}

if (-not $Execute) {
    Write-Host ""
    Write-Host "DRY RUN: no image build, ECR login/push, Runtime update, or Endpoint update will be performed." -ForegroundColor Yellow
    Write-NativeCommand -Command "docker" -Arguments @(
        "buildx", "build", "--platform", "linux/arm64",
        "--progress", "plain",
        "--file", $dockerfilePath,
        "--label", "org.opencontainers.image.revision=$gitCommit",
        "--tag", $imageUri,
        "--push", $agentDirectory
    )
    Write-Host "After push, the script will deploy the immutable digest URI and wait for READY."
    Write-Host "Re-run with -Execute to perform the publish workflow."
    return
}

if ($existingImageDigest) {
    throw "ECR image tag '$imageTag' already exists with digest '$existingImageDigest'. The repository is immutable, so the same Git commit cannot be pushed again. Commit the intended application change and publish the new commit SHA."
}

$failed = $false
$failureMessage = $null
$recordPath = $null
$rollbackCommand = $null
$tempDirectory = Join-Path ([IO.Path]::GetTempPath()) ("bizflow-agent-publish-" + [guid]::NewGuid().ToString("N"))
[void](New-Item -ItemType Directory -Path $tempDirectory)
$recordFileName = ([DateTimeOffset]::UtcNow.ToString("yyyyMMddTHHmmssZ") + "-$gitCommit.json")
$record = [pscustomobject]@{
    schemaVersion = 1
    status = "STARTED"
    startedAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
    updatedAtUtc = $null
    awsProfile = $AWS_PROFILE
    awsRegion = $AWS_REGION
    awsAccountId = [string]$identity.Account
    callerArn = [string]$identity.Arn
    gitCommit = $gitCommit
    imageTag = $imageTag
    imageUri = $imageUri
    imageDigest = $null
    imageDigestUri = $null
    agentRuntimeId = $configuration.AgentRuntimeId
    agentRuntimeArn = $configuration.AgentRuntimeArn
    modelId = $ModelId
    readToolsEnabled = [bool]$EnableReadTools
    gatewayUrl = $gatewayUrl
    runtimeVersion = $null
    endpointName = $configuration.EndpointName
    metadataConfiguration = [ordered]@{
        requireMMDSV2 = $true
    }
    previousEndpointVersion = $null
    endpointLiveVersion = $null
    smokeTest = "NOT_RUN"
    failure = $null
    rollbackCommand = $null
}

try {
    Write-Host "Logging in to private ECR..." -ForegroundColor Cyan
    $loginPassword = Invoke-AwsText -Arguments @("ecr", "get-login-password") -Sensitive
    $loginOutput = @($loginPassword | & docker login --username AWS --password-stdin $ecr.Registry 2>&1)
    $loginExitCode = $LASTEXITCODE
    $loginPassword = $null
    if ($loginExitCode -ne 0) {
        throw "Docker ECR login failed: $($loginOutput -join [Environment]::NewLine)"
    }
    Write-Host "ECR login succeeded."

    $buildArguments = @(
        "buildx", "build", "--platform", "linux/arm64",
        "--progress", "plain",
        "--file", $dockerfilePath,
        "--label", "org.opencontainers.image.revision=$gitCommit",
        "--tag", $imageUri,
        "--push", $agentDirectory
    )
    $buildOutput = Invoke-NativeText -Command "docker" -Arguments $buildArguments
    if ($buildOutput) {
        Write-Host $buildOutput
    }

    $imageDigest = Invoke-AwsText -Arguments @(
        "ecr", "describe-images",
        "--repository-name", $ecr.RepositoryName,
        "--image-ids", "imageTag=$imageTag",
        "--query", "imageDetails[0].imageDigest"
    )
    if ($imageDigest -notmatch '^sha256:[0-9a-f]{64}$') {
        throw "ECR returned an invalid image digest: $imageDigest"
    }
    $imageDigestUri = "$($configuration.EcrRepositoryUri)@$imageDigest"
    $record.imageDigest = $imageDigest
    $record.imageDigestUri = $imageDigestUri
    $record.status = "IMAGE_PUSHED"
    $recordPath = Write-DeploymentRecord -Record $record -Directory $DeploymentRecordDirectory -FileName $recordFileName

    $currentEndpoint = Get-AgentRuntimeEndpoint -AgentRuntimeId $configuration.AgentRuntimeId -EndpointName $configuration.EndpointName
    $currentEndpointStatus = [string](Get-PropertyValue -Object $currentEndpoint -Names @("status"))
    if ($currentEndpointStatus -ne "READY") {
        throw "Endpoint $($configuration.EndpointName) must be READY before an update. Current status: $currentEndpointStatus"
    }
    $previousVersion = [string](Get-PropertyValue -Object $currentEndpoint -Names @("liveVersion") -Optional)
    if (-not $previousVersion) {
        throw "The current endpoint did not report liveVersion."
    }
    $record.previousEndpointVersion = $previousVersion
    $rollbackCommand = New-RollbackCommand -AgentRuntimeId $configuration.AgentRuntimeId -EndpointName $configuration.EndpointName -PreviousVersion $previousVersion
    $record.rollbackCommand = $rollbackCommand

    $clientToken = "bizflow-$gitCommit"
    $runtimeEnvironmentVariables = [ordered]@{
        BIZFLOW_MODEL_ID = $ModelId
        BIZFLOW_AWS_REGION = $AWS_REGION
        BIZFLOW_MODEL_PROVIDER = "bedrock"
    }
    if ($gatewayUrl) {
        $runtimeEnvironmentVariables["BIZFLOW_GATEWAY_URL"] = $gatewayUrl
    }
    $updateRequest = [ordered]@{
        agentRuntimeId = $configuration.AgentRuntimeId
        agentRuntimeArtifact = @{
            containerConfiguration = @{
                containerUri = $imageDigestUri
            }
        }
        roleArn = $configuration.RoleArn
        networkConfiguration = $configuration.NetworkConfiguration
        environmentVariables = $runtimeEnvironmentVariables
        metadataConfiguration = @{
            requireMMDSV2 = $true
        }
        clientToken = $clientToken
    }
    $updateRequestPath = Join-Path $tempDirectory "update-agent-runtime.json"
    $updateRequestJson = $updateRequest | ConvertTo-Json -Depth 20
    [IO.File]::WriteAllText($updateRequestPath, $updateRequestJson, [Text.UTF8Encoding]::new($false))
    $updateRequestUri = "file://" + $updateRequestPath.Replace('\', '/')

    $updateResult = Invoke-AwsJson -Arguments @(
        "bedrock-agentcore-control", "update-agent-runtime",
        "--cli-input-json", $updateRequestUri
    )
    $newRuntimeVersion = [string]$updateResult.agentRuntimeVersion
    if ($newRuntimeVersion -notmatch '^[1-9][0-9]{0,4}$') {
        throw "UpdateAgentRuntime did not return a valid Runtime version."
    }
    $record.agentRuntimeArn = [string]$updateResult.agentRuntimeArn
    $record.runtimeVersion = $newRuntimeVersion
    $record.status = "RUNTIME_UPDATING"
    $recordPath = Write-DeploymentRecord -Record $record -Directory $DeploymentRecordDirectory -FileName $recordFileName

    [void](Wait-AgentRuntimeReady -AgentRuntimeId $configuration.AgentRuntimeId -AgentRuntimeVersion $newRuntimeVersion)
    $record.status = "RUNTIME_READY"
    $recordPath = Write-DeploymentRecord -Record $record -Directory $DeploymentRecordDirectory -FileName $recordFileName

    Write-Host ""
    Write-Host "Runtime version $newRuntimeVersion is READY." -ForegroundColor Green
    Write-Host "Endpoint $($configuration.EndpointName): $previousVersion -> $newRuntimeVersion" -ForegroundColor Yellow
    $confirmation = Read-Host "Type the new Runtime version '$newRuntimeVersion' to update the endpoint"
    if ($confirmation -cne $newRuntimeVersion) {
        $record.status = "RUNTIME_READY_ENDPOINT_UNCHANGED"
        $recordPath = Write-DeploymentRecord -Record $record -Directory $DeploymentRecordDirectory -FileName $recordFileName
        Write-Host "Endpoint update was not confirmed. The existing version remains live." -ForegroundColor Yellow
    }
    else {
        [void](Invoke-AwsJson -Arguments @(
            "bedrock-agentcore-control", "update-agent-runtime-endpoint",
            "--agent-runtime-id", $configuration.AgentRuntimeId,
            "--endpoint-name", $configuration.EndpointName,
            "--agent-runtime-version", $newRuntimeVersion,
            "--client-token", ("endpoint-$gitCommit")
        ))
        $record.status = "ENDPOINT_UPDATING"
        $recordPath = Write-DeploymentRecord -Record $record -Directory $DeploymentRecordDirectory -FileName $recordFileName

        $readyEndpoint = Wait-AgentRuntimeEndpointReady -AgentRuntimeId $configuration.AgentRuntimeId -EndpointName $configuration.EndpointName -ExpectedVersion $newRuntimeVersion
        $record.endpointLiveVersion = [string](Get-PropertyValue -Object $readyEndpoint -Names @("liveVersion"))
        $record.status = "ENDPOINT_READY"
        $recordPath = Write-DeploymentRecord -Record $record -Directory $DeploymentRecordDirectory -FileName $recordFileName

        $smokeTestPath = Join-Path $PSScriptRoot "smoke-test-agentcore.ps1"
        $record.status = "SMOKE_TEST_RUNNING"
        $record.smokeTest = "RUNNING"
        $recordPath = Write-DeploymentRecord -Record $record -Directory $DeploymentRecordDirectory -FileName $recordFileName
        & $smokeTestPath `
            -AWS_PROFILE $AWS_PROFILE `
            -AWS_REGION $AWS_REGION `
            -AgentRuntimeId $configuration.AgentRuntimeId `
            -AgentRuntimeArn $record.agentRuntimeArn `
            -EndpointName $configuration.EndpointName `
            -ExpectedRuntimeVersion $newRuntimeVersion
        if ($LASTEXITCODE -ne 0) {
            throw "AgentCore smoke test failed with exit code $LASTEXITCODE."
        }

        $record.smokeTest = "PASSED"
        $record.status = "SUCCEEDED"
        $recordPath = Write-DeploymentRecord -Record $record -Directory $DeploymentRecordDirectory -FileName $recordFileName
        Write-Host "Deployment succeeded. Record: $recordPath" -ForegroundColor Green
    }
}
catch {
    $failed = $true
    $failureMessage = $_.Exception.Message
    $statusBeforeFailure = $record.status
    $record.status = "FAILED"
    $record.failure = $failureMessage
    if ($statusBeforeFailure -eq "SMOKE_TEST_RUNNING") {
        $record.smokeTest = "FAILED"
    }
    try {
        $recordPath = Write-DeploymentRecord -Record $record -Directory $DeploymentRecordDirectory -FileName $recordFileName
    }
    catch {
        Write-Host "Could not write deployment record: $($_.Exception.Message)" -ForegroundColor Red
    }
    Write-Host "Publish failed: $failureMessage" -ForegroundColor Red
    if ($recordPath) {
        Write-Host "Deployment record: $recordPath"
    }
}
finally {
    if (Test-Path -LiteralPath $tempDirectory -PathType Container) {
        $tempParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
        $resolvedTemp = [IO.Path]::GetFullPath($tempDirectory)
        if ($resolvedTemp.StartsWith($tempParent + '\') -and [IO.Path]::GetFileName($resolvedTemp).StartsWith("bizflow-agent-publish-")) {
            Remove-Item -LiteralPath $resolvedTemp -Recurse -Force
        }
    }

    Write-Host ""
    Write-Host "Rollback command" -ForegroundColor Yellow
    if ($rollbackCommand) {
        Write-Host $rollbackCommand
    }
    else {
        Write-Host "Unavailable because the previous endpoint version was not retrieved."
    }
}

if ($failed) {
    exit 1
}
