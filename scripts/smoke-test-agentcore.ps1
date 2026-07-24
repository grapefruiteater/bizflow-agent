[CmdletBinding(DefaultParameterSetName = "Remote")]
param(
    [Parameter(Mandatory = $true, ParameterSetName = "Remote")]
    [ValidateNotNullOrEmpty()]
    [string]$AWS_PROFILE,

    [Parameter(Mandatory = $true, ParameterSetName = "Remote")]
    [ValidateNotNullOrEmpty()]
    [string]$AWS_REGION,

    [Parameter(Mandatory = $true, ParameterSetName = "Remote")]
    [ValidateNotNullOrEmpty()]
    [string]$AgentRuntimeId,

    [Parameter(Mandatory = $true, ParameterSetName = "Remote")]
    [ValidateNotNullOrEmpty()]
    [string]$AgentRuntimeArn,

    [Parameter(ParameterSetName = "Remote")]
    [ValidateNotNullOrEmpty()]
    [string]$EndpointName = "PROD",

    [Parameter(Mandatory = $true, ParameterSetName = "Remote")]
    [ValidatePattern('^[1-9][0-9]{0,4}$')]
    [string]$ExpectedRuntimeVersion,

    [Parameter(Mandatory = $true, ParameterSetName = "Local")]
    [ValidateNotNullOrEmpty()]
    [string]$LocalBaseUrl,

    [ValidateNotNullOrEmpty()]
    [string]$Prompt = "Return a short BizFlow Agent health confirmation.",

    [string]$ExpectedResponsePattern,

    [Parameter(ParameterSetName = "Remote")]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$')]
    [string]$RuntimeSessionId,

    [switch]$RequireMemory,

    [ValidateRange(0, 100)]
    [int]$MinimumMemoryContextTurns = 0
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Assert-CommandExists {
    param([Parameter(Mandatory = $true)][string]$Name)

    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required command '$Name' was not found in PATH."
    }
}

function Invoke-NativeText {
    param(
        [Parameter(Mandatory = $true)][string]$Command,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    $outputLines = @(& $Command @Arguments 2>&1)
    $exitCode = $LASTEXITCODE
    $text = ($outputLines | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine
    if ($exitCode -ne 0) {
        throw "Command failed with exit code ${exitCode}: $Command`n$text"
    }
    return $text.Trim()
}

function Invoke-AwsJson {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)

    $allArguments = @($Arguments) + @(
        "--profile", $AWS_PROFILE,
        "--region", $AWS_REGION,
        "--no-cli-pager",
        "--output", "json"
    )
    $json = Invoke-NativeText -Command "aws" -Arguments $allArguments
    try {
        return $json | ConvertFrom-Json
    }
    catch {
        throw "AWS CLI did not return valid JSON.`n$json"
    }
}

function Get-PropertyValue {
    param(
        [Parameter(Mandatory = $true)][object]$Object,
        [Parameter(Mandatory = $true)][string[]]$Names
    )

    foreach ($name in $Names) {
        $property = $Object.PSObject.Properties[$name]
        if ($null -ne $property -and $null -ne $property.Value) {
            return $property.Value
        }
    }
    throw "Response is missing required value. Accepted keys: $($Names -join ', ')"
}

function Assert-SmokeResponse {
    param([Parameter(Mandatory = $true)][object]$Response)

    if ([string]$Response.status -ne "success") {
        throw "Invocation response status was not 'success'."
    }
    if (-not $Response.response -or -not ($Response.response -is [string])) {
        throw "Invocation response did not contain a non-empty string field named 'response'."
    }
    if ([string]$Response.output_contract_version -ne "1.0") {
        throw "Invocation response did not report output_contract_version=1.0."
    }
    if ($null -eq $Response.PSObject.Properties["proposed_actions"]) {
        throw "Invocation response did not contain proposed_actions."
    }
    if ([string]$Response.execution_mode -ne "READ_ONLY") {
        throw "Invocation response did not report execution_mode=READ_ONLY."
    }
    if ($null -eq $Response.PSObject.Properties["write_operations_performed"] -or
        [bool]$Response.write_operations_performed) {
        throw "Invocation response did not confirm that no write operation was performed."
    }
    if ($ExpectedResponsePattern -and
        [string]$Response.response -notmatch $ExpectedResponsePattern) {
        throw "Invocation response did not match the expected response pattern."
    }
    if ($RequireMemory) {
        $memoryProperty = $Response.PSObject.Properties["memory"]
        if ($null -eq $memoryProperty -or $null -eq $memoryProperty.Value) {
            throw "Invocation response did not contain Memory status."
        }
        $memory = $memoryProperty.Value
        if (-not [bool](Get-PropertyValue -Object $memory -Names @("enabled"))) {
            throw "Invocation response did not report Memory as enabled."
        }
        if (-not [bool](Get-PropertyValue -Object $memory -Names @("session_available"))) {
            throw "Invocation response did not report a Runtime session for Memory."
        }
        if ([bool](Get-PropertyValue -Object $memory -Names @("degraded"))) {
            throw "Invocation response reported degraded Memory operations."
        }
        if (-not [bool](Get-PropertyValue -Object $memory -Names @("event_stored"))) {
            throw "Invocation response did not confirm that the conversation event was stored."
        }
        $contextTurns = [int](Get-PropertyValue -Object $memory -Names @("context_turns"))
        if ($contextTurns -lt $MinimumMemoryContextTurns) {
            throw "Invocation response reported $contextTurns Memory context turns; expected at least $MinimumMemoryContextTurns."
        }
    }
}

function Invoke-LocalSmokeTest {
    $baseUrl = $LocalBaseUrl.TrimEnd('/')
    $ping = Invoke-RestMethod -Method Get -Uri "$baseUrl/ping" -TimeoutSec 15
    if ([string]$ping.status -ne "Healthy") {
        throw "Local /ping response was not Healthy."
    }
    Write-Host "Local /ping: Healthy" -ForegroundColor Green

    $requestBody = @{ prompt = $Prompt } | ConvertTo-Json -Compress
    $response = Invoke-RestMethod `
        -Method Post `
        -Uri "$baseUrl/invocations" `
        -ContentType "application/json" `
        -Body $requestBody `
        -TimeoutSec 30
    Assert-SmokeResponse -Response $response
    Write-Host "Local /invocations: Passed" -ForegroundColor Green
}

function Invoke-RemoteSmokeTest {
    Assert-CommandExists -Name "aws"

    $identity = Invoke-AwsJson -Arguments @("sts", "get-caller-identity")
    Write-Host "Smoke-test caller: $($identity.Arn)"
    if ($identity.Arn -match '^arn:aws(?:-[a-z]+)*:iam::\d{12}:root$') {
        throw "Smoke testing as the AWS account root user is prohibited."
    }

    $endpoint = Invoke-AwsJson -Arguments @(
        "bedrock-agentcore-control", "get-agent-runtime-endpoint",
        "--agent-runtime-id", $AgentRuntimeId,
        "--endpoint-name", $EndpointName
    )
    if ($endpoint.status -ne "READY") {
        throw "Endpoint $EndpointName is not READY. Current status: $($endpoint.status)"
    }
    if ([string]$endpoint.liveVersion -ne $ExpectedRuntimeVersion) {
        throw "Endpoint $EndpointName serves version $($endpoint.liveVersion), expected $ExpectedRuntimeVersion."
    }
    Write-Host "Endpoint health: READY, liveVersion=$($endpoint.liveVersion)" -ForegroundColor Green

    $tempDirectory = Join-Path ([IO.Path]::GetTempPath()) ("bizflow-agent-smoke-" + [guid]::NewGuid().ToString("N"))
    [void](New-Item -ItemType Directory -Path $tempDirectory)
    try {
        $payloadPath = Join-Path $tempDirectory "payload.json"
        $responsePath = Join-Path $tempDirectory "response.json"
        $payloadJson = @{ prompt = $Prompt } | ConvertTo-Json -Compress
        [IO.File]::WriteAllText($payloadPath, $payloadJson, [Text.UTF8Encoding]::new($false))
        $payloadUri = "fileb://" + $payloadPath.Replace('\', '/')
        $sessionId = if ($RuntimeSessionId) {
            $RuntimeSessionId
        }
        else {
            [guid]::NewGuid().ToString()
        }

        $arguments = @(
            "bedrock-agentcore", "invoke-agent-runtime",
            "--content-type", "application/json",
            "--accept", "application/json",
            "--runtime-session-id", $sessionId,
            "--agent-runtime-arn", $AgentRuntimeArn,
            "--qualifier", $EndpointName,
            "--payload", $payloadUri,
            $responsePath,
            "--cli-binary-format", "raw-in-base64-out",
            "--profile", $AWS_PROFILE,
            "--region", $AWS_REGION,
            "--no-cli-pager"
        )
        [void](Invoke-NativeText -Command "aws" -Arguments $arguments)

        if (-not (Test-Path -LiteralPath $responsePath -PathType Leaf)) {
            throw "InvokeAgentRuntime did not create a response file."
        }
        $responseText = Get-Content -LiteralPath $responsePath -Raw -Encoding UTF8
        if (-not $responseText) {
            throw "InvokeAgentRuntime returned an empty response."
        }
        try {
            $response = $responseText | ConvertFrom-Json
        }
        catch {
            throw "InvokeAgentRuntime response was not valid JSON.`n$responseText"
        }
        Assert-SmokeResponse -Response $response
        Write-Host "Remote invocation: Passed" -ForegroundColor Green
    }
    finally {
        if (Test-Path -LiteralPath $tempDirectory -PathType Container) {
            $tempParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
            $resolvedTemp = [IO.Path]::GetFullPath($tempDirectory)
            if ($resolvedTemp.StartsWith($tempParent + '\') -and [IO.Path]::GetFileName($resolvedTemp).StartsWith("bizflow-agent-smoke-")) {
                Remove-Item -LiteralPath $resolvedTemp -Recurse -Force
            }
        }
    }
}

try {
    if ($PSCmdlet.ParameterSetName -eq "Local") {
        Invoke-LocalSmokeTest
    }
    else {
        Invoke-RemoteSmokeTest
    }
    Write-Host "Smoke test succeeded." -ForegroundColor Green
    exit 0
}
catch {
    Write-Host "Smoke test failed: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
