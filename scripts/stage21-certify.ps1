param(
  [string]$OutputDirectory = (Join-Path (Get-Location).Path 'artifacts\stage21'),
  [string]$BrowserGymRunner = 'C:\Users\SAMPATH\Documents\Codex\2026-09-30\files-pasted-by-the-user-complete\work\stage21-browsergym-candidate\release_browsergym_runner.mjs',
  [string]$BrowserGymResult = 'C:\Users\SAMPATH\Documents\Codex\2026-09-30\files-pasted-by-the-user-complete\work\stage21-browsergym-candidate\results\browsergym-candidate.json',
  [string]$RelayConcurrencyRunner = 'C:\Users\SAMPATH\Documents\Codex\2026-09-30\files-pasted-by-the-user-complete\work\stage21-browsergym-candidate\relay_concurrency_candidate.mjs',
  [string]$ReleaseHelperDirectory = 'C:\Users\SAMPATH\OneDrive\Desktop\Mecord-Release-2.0.3\packages\mecord-connect\runtime\native'
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$logDirectory = Join-Path $OutputDirectory 'logs'
New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
@('summary.json','REPORT.md','environment.json','repo-tests.json','performance.json','security.json','relay-concurrency.json','durable-task.json','windows-path.json','browsergym.json','hosted-mcp.json','hosted-latency.json','hosted-replay-regression.json') | ForEach-Object { Remove-Item -LiteralPath (Join-Path $OutputDirectory $_) -Force -ErrorAction SilentlyContinue }
@('repository-tests.log','red-team.log','performance.log','browsergym.log','relay-concurrency-local.log','runtime-build.log','package-dry-run.log') | ForEach-Object { Remove-Item -LiteralPath (Join-Path $logDirectory $_) -Force -ErrorAction SilentlyContinue }

function Invoke-Logged([string]$Name, [string]$Executable, [string[]]$Arguments, [string]$WorkingDirectory) {
  $log = Join-Path $logDirectory "$Name.log"
  Push-Location $WorkingDirectory
  try {
    $captured = & $Executable @Arguments 2>&1
    $exit = $LASTEXITCODE
    $captured | Set-Content -Encoding utf8 $log
  } finally { Pop-Location }
  return [pscustomobject]@{ name=$Name; command="$Executable $($Arguments -join ' ')"; log=(Split-Path $log -Leaf); exitCode=$exit }
}

function Read-TapCounts([string]$Path) {
  $content = Get-Content $Path -Raw
  $tests = [regex]::Match($content, '(?m)^# tests (\d+)\s*$')
  $passed = [regex]::Match($content, '(?m)^# pass (\d+)\s*$')
  $failed = [regex]::Match($content, '(?m)^# fail (\d+)\s*$')
  $skipped = [regex]::Match($content, '(?m)^# skipped (\d+)\s*$')
  if (!$tests.Success -or !$passed.Success -or !$failed.Success) { throw "Could not parse TAP summary: $Path" }
  return [ordered]@{ tests=[int]$tests.Groups[1].Value; passed=[int]$passed.Groups[1].Value; failed=[int]$failed.Groups[1].Value; skipped=if($skipped.Success){[int]$skipped.Groups[1].Value}else{0} }
}

$checks = [Collections.Generic.List[object]]::new()
$failedGate = $false
$head = (& git -C $repo rev-parse HEAD).Trim()
$baseline = '2d6c2e85de0047d2fb76f0af9fa25b2170f7646d'
$lease = Join-Path $repo 'native\windows-path-lease\target\release\operator-windows-path-lease.exe'
if (!(Test-Path $lease)) { throw "Required Windows path-lease test helper is missing: $lease" }
$leaseHash = (Get-FileHash $lease -Algorithm SHA256).Hash.ToLowerInvariant()
if ($leaseHash -ne 'e22684d4b579bb87929123c8b10e34bea2f256dca31502ea1b2579ffd6816d67') { throw "Unexpected path-lease helper hash: $leaseHash" }
$env:OPERATOR_WINDOWS_PATH_LEASE_PATH = (Resolve-Path $lease).Path

$testFiles = @(Get-ChildItem (Join-Path $repo 'test') -Filter '*.test.ts' | Sort-Object Name | ForEach-Object FullName)
$checks.Add((Invoke-Logged 'repository-tests' 'node' (@('--experimental-strip-types','--test','--test-concurrency=1') + $testFiles) $repo))
$checks.Add((Invoke-Logged 'red-team' 'npm' @('run','test:red-team') $repo))
$checks.Add((Invoke-Logged 'performance' 'npm' @('run','test:performance') $repo))
$browserRunStarted = Get-Date
$checks.Add((Invoke-Logged 'browsergym' 'node' @('--experimental-strip-types',$BrowserGymRunner) $repo))
$checks.Add((Invoke-Logged 'relay-concurrency-local' 'node' @('--experimental-strip-types',$RelayConcurrencyRunner) $repo))

$nativeManifest = Get-Content (Join-Path $ReleaseHelperDirectory '..\runtime-manifest.json') -Raw | ConvertFrom-Json
$helperFiles = @('operator-windows-dpapi.exe','operator-windows-uia.exe','operator-windows-path-lease.exe')
foreach ($file in $helperFiles) {
  $item = $nativeManifest.files | Where-Object { $_.path -eq "native/$file" }
  if (!$item -or (Get-FileHash (Join-Path $ReleaseHelperDirectory $file) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $item.sha256) { throw "Release helper hash does not match its recorded manifest: $file" }
}
$env:OPERATOR_BUILD_DPAPI_PATH = Join-Path $ReleaseHelperDirectory $helperFiles[0]
$env:OPERATOR_BUILD_UIA_PATH = Join-Path $ReleaseHelperDirectory $helperFiles[1]
$env:OPERATOR_BUILD_PATH_LEASE_PATH = Join-Path $ReleaseHelperDirectory $helperFiles[2]
$packageDir = Join-Path $repo 'packages\mecord-connect'
$checks.Add((Invoke-Logged 'runtime-build' 'npm' @('run','build:runtime') $packageDir))
$checks.Add((Invoke-Logged 'package-dry-run' 'npm' @('pack','--dry-run') $packageDir))

$testCounts = Read-TapCounts (Join-Path $logDirectory 'repository-tests.log')
$securityCounts = Read-TapCounts (Join-Path $logDirectory 'red-team.log')
$performanceCounts = Read-TapCounts (Join-Path $logDirectory 'performance.log')
$perfText = Get-Content (Join-Path $logDirectory 'performance.log')
$perfRows = @($perfText | ForEach-Object { if ($_ -match '\[perf\] ([^:]+): .*\(([0-9.]+) ms/op\)') { [ordered]@{name=$Matches[1];msPerOp=[double]$Matches[2]} } })
if (!(Test-Path $BrowserGymResult) -or (Get-Item $BrowserGymResult).LastWriteTime -lt $browserRunStarted) { throw 'BrowserGym result was not freshly written during this run; refusing to use stale output.' }
$browser = Get-Content $BrowserGymResult -Raw | ConvertFrom-Json
$relayText = Get-Content (Join-Path $logDirectory 'relay-concurrency-local.log') -Raw
$relayStart = $relayText.IndexOf('{')
if ($relayStart -lt 0) { throw 'Relay runner emitted no JSON measurement.' }
$relay = $relayText.Substring($relayStart) | ConvertFrom-Json
$manifest = Get-Content (Join-Path $packageDir 'runtime\runtime-manifest.json') -Raw | ConvertFrom-Json
$browser.subject.package = "$($manifest.package)@$($manifest.version) candidate-source"
$browser.subject.source = "baseline $baseline; candidate commit $head"
$failedGate = @($checks | Where-Object exitCode -ne 0).Count -gt 0 -or $testCounts.failed -ne 0 -or $securityCounts.failed -ne 0 -or $performanceCounts.failed -ne 0 -or $browser.successes -ne 7

$environment = [ordered]@{ capturedAt=(Get-Date).ToUniversalTime().ToString('o');hostname=$env:COMPUTERNAME;os=[Environment]::OSVersion.VersionString;architecture=$env:PROCESSOR_ARCHITECTURE;node=(& node --version);python=(& python --version 2>&1);browsergymPython=$browser.environment.python;package=$manifest.package+'@'+$manifest.version;baselineCommit=$baseline;candidateCommit=$head;runtimeManifestCommit=$manifest.sourceCommit;browsergym=$browser.environment.browsergym;playwright=$browser.environment.playwright;miniwobCommit=$browser.environment.miniwobCommit;pathLeaseSha256=$leaseHash;globalInstalledRuntime='unchanged; not used as candidate'}
$environment | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8 (Join-Path $OutputDirectory 'environment.json')
$repoResult = [ordered]@{status=if($testCounts.failed -eq 0){'PASS'}else{'FAIL'};command='node --experimental-strip-types --test --test-concurrency=1 <sorted test/*.test.ts>';counts=$testCounts;log='logs/repository-tests.log'}
$repoResult | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8 (Join-Path $OutputDirectory 'repo-tests.json')
$security = [ordered]@{status=if($securityCounts.failed -eq 0){'PASS'}else{'FAIL'};counts=$securityCounts;resilienceMatrix='covered by red-team suite';log='logs/red-team.log'}
$security | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8 (Join-Path $OutputDirectory 'security.json')
$performance = [ordered]@{status=if($performanceCounts.failed -eq 0){'PASS'}else{'FAIL'};counts=$performanceCounts;measurements=$perfRows;log='logs/performance.log'}
$performance | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8 (Join-Path $OutputDirectory 'performance.json')
$browser | ConvertTo-Json -Depth 30 | Set-Content -Encoding utf8 (Join-Path $OutputDirectory 'browsergym.json')
$relay | ConvertTo-Json -Depth 15 | Set-Content -Encoding utf8 (Join-Path $OutputDirectory 'relay-concurrency.json')
[ordered]@{local='Covered by repository tests';hosted='NOT RUN';log='logs/repository-tests.log'} | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $OutputDirectory 'durable-task.json')
[ordered]@{local='Covered by repository tests';hosted='NOT RUN';pathLeaseSha256=$leaseHash;helperManifestSource='mecord-connect@2.0.3 runtime manifest'} | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $OutputDirectory 'windows-path.json')
$hosted = [ordered]@{status='NOT_RUN_EXTERNAL_ENVIRONMENT_REQUIRED';endpoint='https://operator.splcart.in/mcp';reason='No authorized hosted Mecord MCP/ChatGPT execution surface is exposed in this Codex environment.';required='Run in authorized ChatGPT developer workspace with paired LAPTOP-MRNU23B2 runtime; use dedicated benchmark root and existing trusted registrations; collect secret-free receipts for hosted latency, relay scheduling, durable task, browser, and filesystem gates.'}
$hosted | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8 (Join-Path $OutputDirectory 'hosted-mcp.json')
[ordered]@{status='NOT_MEASURED_HOSTED';samples=@();required='Record UTC request/accept/final/device/ACK timestamps for multiple fresh hosted samples.'} | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $OutputDirectory 'hosted-latency.json')
[ordered]@{status='LOCAL_REGRESSION_ONLY';hosted='NOT RUN';regression='See same-task retry versus fresh invocation test in relay-server suite.'} | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $OutputDirectory 'hosted-replay-regression.json')

$hostedPending = $true
$result = if ($failedGate) {'FAIL'} else {'HOSTED_MCP_EXECUTION_REQUIRED'}
$summary = [ordered]@{result=$result;generatedAt=(Get-Date).ToUniversalTime().ToString('o');baselineCommit=$baseline;candidateCommit=$head;package=$manifest.version;localGates=if($failedGate){'FAIL'}else{'PASS'};hosted='NOT RUN';checks=$checks;repository=$testCounts;redTeam=$securityCounts;performance=$performanceCounts;browsergym=@{successes=$browser.successes;tasks=$browser.tasks};reason='Hosted ChatGPT/MCP surface is not exposed in this environment.'}
$summary | ConvertTo-Json -Depth 15 | Set-Content -Encoding utf8 (Join-Path $OutputDirectory 'summary.json')
$markdown = @("# Stage 21 certification",'',"**Result: $result**",'',"Baseline: ``$baseline``  ","Candidate: ``$head``  ","Package: ``$($manifest.package)@$($manifest.version)``",'',"Local gates: $($(if($failedGate){'FAIL'}else{'PASS'})); hosted gates: NOT RUN.",'',"Repository tests: $($testCounts.passed) passed, $($testCounts.failed) failed, $($testCounts.skipped) skipped.","Red-team: $($securityCounts.passed) passed, $($securityCounts.failed) failed.","Performance: $($performanceCounts.passed) passed, $($performanceCounts.failed) failed.","BrowserGym: $($browser.successes)/$($browser.tasks).",'',"Reproduce with ``powershell -ExecutionPolicy Bypass -File scripts/stage21-certify.ps1 -OutputDirectory <certificate-directory>``. The command always exits nonzero while hosted certification is pending.",'',"Hosted certification requires an authorized ChatGPT workspace connected to https://operator.splcart.in/mcp and the paired LAPTOP-MRNU23B2 runtime. See hosted-mcp.json for the remaining workflow. Local relay measurements are simulations and are not hosted evidence.")
$markdown | Set-Content -Encoding utf8 (Join-Path $OutputDirectory 'REPORT.md')

if ($failedGate) { exit 1 }
if ($hostedPending) { Write-Warning 'Local gates passed; hosted MCP execution remains required. Artifacts were written.'; exit 2 }
