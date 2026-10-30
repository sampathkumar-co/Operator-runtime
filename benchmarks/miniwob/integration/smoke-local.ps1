$ErrorActionPreference='Stop'
$root=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$py=Join-Path $root 'bg-meta-venv311\Scripts\python.exe'
$chrome='C:\Program Files\Google\Chrome\Application\chrome.exe'
$runtime=Join-Path $root 'isolated-install\node_modules\mecord-connect'
$manifest=Join-Path $runtime 'runtime\runtime-manifest.json'
foreach($file in @($py,$chrome,$manifest,(Join-Path $root 'miniwob-plusplus\miniwob\html\miniwob'))) {
 if(-not (Test-Path $file)){throw "REQUIRED_ISOLATED_COMPONENT_MISSING $file"}
}
$meta=Get-Content $manifest -Raw | ConvertFrom-Json
if($meta.version -ne '2.0.7-rc.6' -or $meta.sourceCommit -ne 'beef93d3aa9c2c1363e92a6b3b78c893bf1a0ad4') {
 throw 'ISOLATED_RUNTIME_NOT_SOURCE_PINNED'
}
$env:MECORD_MINIWOB_WORKDIR=$root
$env:MECORD_MINIWOB_RUNTIME_PATH=$runtime
$env:MECORD_MINIWOB_CHROME=$chrome
$env:PLAYWRIGHT_BROWSERS_PATH=Join-Path $env:LOCALAPPDATA 'ms-playwright'
Remove-Item Env:MUSE_API_KEY -ErrorAction SilentlyContinue
foreach($name in @('smoke.py','smoke_visual.py')){
 Write-Output "RUNNING_NO_MODEL $name"
 & $py (Join-Path $PSScriptRoot $name)
 if($LASTEXITCODE -ne 0){throw "NO_MODEL_SMOKE_FAILED $name"}
}
Write-Output 'ISOLATED_MINIWOB_NO_MODEL_CHECKS_PASSED'
