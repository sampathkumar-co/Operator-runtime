param(
  [string]$Output = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = $PSScriptRoot
if (-not $Output) { $Output = Join-Path $root 'target\release\operator-windows-path-lease.exe' }
$Output = [IO.Path]::GetFullPath($Output)

$candidates = @(
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
)
$compiler = $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $compiler) { throw 'Windows .NET Framework C# compiler (csc.exe) was not found.' }

New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($Output)) | Out-Null
& $compiler /nologo /optimize+ /platform:x64 /target:exe "/out:$Output" (Join-Path $root 'Program.cs')
if ($LASTEXITCODE -ne 0) { throw "path-lease helper compile failed with exit code $LASTEXITCODE" }

& $Output --self-test
if ($LASTEXITCODE -ne 0) { throw 'path-lease helper self-test failed' }
Write-Host "[operator-path-lease] built $Output"