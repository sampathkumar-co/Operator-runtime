$ErrorActionPreference='Stop'
$root=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$source='C:\Users\SAMPATH\OneDrive\Desktop\Mecord-Native-Graphics-20261030'
$commit='7e73340fa8478810b9a14ee5d6943caf9dbea6ed'
$py=Join-Path $root 'bg-meta-venv311\Scripts\python.exe'
$chrome='C:\Program Files\Google\Chrome\Application\chrome.exe'
$runtime=Join-Path $root 'isolated-install\node_modules\mecord-connect'
$manifest=Join-Path $runtime 'runtime\runtime-manifest.json'
foreach($needed in @($py,$chrome,$manifest,(Join-Path $source 'src\capabilities\browser-cdp.ts'))){
 if(!(Test-Path $needed)){throw "NATIVE_SMOKE_COMPONENT_MISSING $needed"}
}
$actual=(& git -C $source rev-parse HEAD).Trim()
if($actual -ne $commit){throw 'NATIVE_SMOKE_SOURCE_NOT_PINNED'}
$meta=Get-Content $manifest -Raw|ConvertFrom-Json
if($meta.version -ne '2.0.7-rc.6' -or $meta.sourceCommit -ne 'beef93d3aa9c2c1363e92a6b3b78c893bf1a0ad4'){
 throw 'NATIVE_SMOKE_RC6_NOT_PINNED'
}
$env:MECORD_MINIWOB_WORKDIR=$root
$env:MECORD_MINIWOB_RUNTIME_PATH=$runtime
$env:MECORD_MINIWOB_NATIVE_SOURCE_ROOT=$source
$env:MECORD_MINIWOB_CHROME=$chrome
$env:PLAYWRIGHT_BROWSERS_PATH=Join-Path $env:LOCALAPPDATA 'ms-playwright'
Remove-Item Env:MUSE_API_KEY -ErrorAction SilentlyContinue
foreach($name in @('smoke_native.py','smoke_native_shift.py')){
 Write-Output "RUNNING_NATIVE_SOURCE_SMOKE $name"
 & $py (Join-Path $PSScriptRoot $name)
 if($LASTEXITCODE -ne 0){throw "NATIVE_SMOKE_FAILED $name"}
}
Write-Output 'RUNNING_NATIVE_PROVIDER_DRAW_PATH'
& node --experimental-strip-types (Join-Path $source 'test\native-graphical-physical-smoke.mjs')
if($LASTEXITCODE -ne 0){throw 'NATIVE_PATH_SMOKE_FAILED'}
Write-Output 'NATIVE_GRAPHICAL_SMOKE_SUITE_PASS'
