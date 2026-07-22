[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$AWS_PROFILE,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$AWS_REGION,

    [string]$ToolsConfigPath,

    [ValidatePattern('^\d{4}-\d{2}-\d{2}$')]
    [string]$StartDate = "2026-07-10",

    [ValidatePattern('^\d{4}-\d{2}-\d{2}$')]
    [string]$EndDate = "2026-07-13",

    [ValidatePattern('^\d{4}-\d{2}-\d{2}$')]
    [string]$AsOf = "2026-07-13"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-OutputValue {
    param(
        [Parameter(Mandatory = $true)][object]$Document,
        [Parameter(Mandatory = $true)][string]$Name
    )

    $direct = $Document.PSObject.Properties[$Name]
    if ($null -ne $direct -and $direct.Value) {
        return [string]$direct.Value
    }
    foreach ($stackProperty in $Document.PSObject.Properties) {
        if ($stackProperty.Value -isnot [psobject]) {
            continue
        }
        $nested = $stackProperty.Value.PSObject.Properties[$Name]
        if ($null -ne $nested -and $nested.Value) {
            return [string]$nested.Value
        }
    }
    throw "Output '$Name' was not found in $ToolsConfigPath."
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if (-not $ToolsConfigPath) {
    $ToolsConfigPath = Join-Path $repoRoot "config\tools-outputs.json"
}
elseif (-not [IO.Path]::IsPathRooted($ToolsConfigPath)) {
    $ToolsConfigPath = Join-Path $repoRoot $ToolsConfigPath
}
if (-not (Test-Path -LiteralPath $ToolsConfigPath -PathType Leaf)) {
    throw "Tools Outputs file was not found: $ToolsConfigPath"
}

try {
    $toolsOutputs = Get-Content -LiteralPath $ToolsConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
}
catch {
    throw "Tools Outputs file is not valid JSON: $ToolsConfigPath"
}
$gatewayUrl = Get-OutputValue -Document $toolsOutputs -Name "BusinessToolsGatewayUrl"

$pythonPath = Join-Path $repoRoot ".venv\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $pythonPath -PathType Leaf)) {
    $pythonCommand = Get-Command python -ErrorAction SilentlyContinue
    if ($null -eq $pythonCommand) {
        throw "Python was not found. Create .venv or add python to PATH."
    }
    $pythonPath = $pythonCommand.Source
}

Write-Host "Gateway read-tool smoke test" -ForegroundColor Cyan
Write-Host "  Profile: $AWS_PROFILE"
Write-Host "  Region:  $AWS_REGION"
Write-Host "  Config:  $ToolsConfigPath"
Write-Host "  Gateway: $gatewayUrl"

& $pythonPath (Join-Path $PSScriptRoot "smoke_test_gateway.py") `
    --profile $AWS_PROFILE `
    --region $AWS_REGION `
    --gateway-url $gatewayUrl `
    --start-date $StartDate `
    --end-date $EndDate `
    --as-of $AsOf
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}
exit 0
