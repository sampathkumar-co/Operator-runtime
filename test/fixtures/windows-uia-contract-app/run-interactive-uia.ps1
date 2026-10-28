param(
  [Parameter(Mandatory=$true)][string]$SidecarPath,
  [string]$Configuration = 'Release'
)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'Interactive UIA fixture requires an owner-controlled interactive Windows session.' }
$sidecar = (Resolve-Path -LiteralPath $SidecarPath).Path
$project = Join-Path $PSScriptRoot 'WindowsUiaContractApp.csproj'
& dotnet build $project --configuration $Configuration --nologo
if ($LASTEXITCODE -ne 0) { throw 'Fixture build failed.' }
$dll = Join-Path $PSScriptRoot "bin\$Configuration\net8.0-windows\WindowsUiaContractApp.dll"
$app = Start-Process dotnet -ArgumentList @($dll) -PassThru
$native = $null
try {
  $start = New-Object System.Diagnostics.ProcessStartInfo
  $start.FileName = $sidecar
  $start.UseShellExecute = $false
  $start.RedirectStandardInput = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $start.CreateNoWindow = $true
  $native = [System.Diagnostics.Process]::Start($start)
  function Invoke-Uia([string]$Id, [string]$Method, [hashtable]$Params) {
    $native.StandardInput.WriteLine((@{id=$Id;method=$Method;params=$Params} | ConvertTo-Json -Depth 8 -Compress))
    $native.StandardInput.Flush()
    $line = $native.StandardOutput.ReadLine()
    if (-not $line) { throw "UIA sidecar closed during $Id" }
    $response = $line | ConvertFrom-Json
    if ($response.id -ne $Id -or $response.ok -ne $true) {
      throw "UIA request $Id failed: $($response.error.code)"
    }
    return $response.result
  }
  $health = Invoke-Uia 'health' 'health' @{}
  if ($health.service -ne 'operator-windows-uia' -or $health.protocol -ne 1 -or $health.uia_available -ne $true) {
    throw 'Native UIA is unavailable in this interactive session.'
  }
  $pidSelector = @{ process_id = $app.Id }
  $main = Invoke-Uia 'inspect-main' 'inspect' @{ selector = $pidSelector + @{ automation_id='main-window' }; max_nodes=10; max_depth=2; wait_ms=10000 }
  if (@($main.elements).Count -ne 1 -or $main.elements[0].process_id -ne $app.Id) { throw 'Main window process binding failed.' }
  $name = $pidSelector + @{ automation_id='name-field' }
  $null = Invoke-Uia 'focus-name' 'operate' @{ operation='focus'; selector=$name; wait_ms=5000 }
  $set = Invoke-Uia 'set-name' 'operate' @{ operation='set_value'; selector=$name; value='Owner session fixture'; wait_ms=5000 }
  if ($set.before.process_id -ne $app.Id -or $set.after.process_id -ne $app.Id -or $set.postcondition.verified -ne $true) { throw 'Set-value identity/postcondition failed.' }
  $save = Invoke-Uia 'invoke-save' 'operate' @{ operation='invoke'; selector=($pidSelector + @{ automation_id='save-button' }); wait_ms=5000 }
  if ($save.before.process_id -ne $app.Id -or $save.after.process_id -ne $app.Id) { throw 'Invoke identity binding failed.' }
  $status = Invoke-Uia 'inspect-status' 'inspect' @{ selector=($pidSelector + @{ automation_id='status-label'; name='Saved: Owner session fixture' }); max_nodes=2; max_depth=1; wait_ms=5000 }
  if (@($status.elements).Count -ne 1 -or $status.elements[0].process_id -ne $app.Id) { throw 'Status postcondition was not observed.' }
  $native.StandardInput.WriteLine((@{id='wrong-process';method='inspect';params=@{selector=@{process_id=4;automation_id='main-window'};max_nodes=1;max_depth=1;wait_ms=0}} | ConvertTo-Json -Depth 8 -Compress))
  $native.StandardInput.Flush()
  $wrong = $native.StandardOutput.ReadLine() | ConvertFrom-Json
  if ($wrong.ok -eq $true) { throw 'Wrong-process selector unexpectedly matched the fixture.' }
  [ordered]@{ schemaVersion=1; fixtureProcessId=$app.Id; cases=6; result='PHYSICAL_INTERACTIVE_VERIFIED'; protectedWindowsTouched=$false } | ConvertTo-Json
} finally {
  if ($native -and -not $native.HasExited) { $native.Kill(); $native.WaitForExit(5000) | Out-Null }
  if ($app -and -not $app.HasExited) { Stop-Process -Id $app.Id -Force }
}
