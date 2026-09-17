param(
  [string]$Output = '',
  [switch]$RequireDeterministic
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = $PSScriptRoot
if (-not $Output) { $Output = Join-Path $root 'target\release\operator-windows-path-lease.exe' }
$Output = [IO.Path]::GetFullPath($Output)
if ($env:CI -eq 'true') { $RequireDeterministic = $true }

function Find-RoslynCompiler {
  $programRoots = @($env:ProgramFiles, ${env:ProgramFiles(x86)}) | Where-Object { -not [String]::IsNullOrWhiteSpace($_) }
  foreach ($programRoot in $programRoots) {
    $vswhere = Join-Path $programRoot 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (-not (Test-Path -LiteralPath $vswhere -PathType Leaf)) { continue }
    $installations = @(& $vswhere -products '*' -all -requires Microsoft.Component.MSBuild -property installationPath)
    foreach ($installation in $installations) {
      if ([String]::IsNullOrWhiteSpace($installation)) { continue }
      $candidate = Join-Path $installation 'MSBuild\Current\Bin\Roslyn\csc.exe'
      if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
  }

  foreach ($programRoot in $programRoots) {
    $vsRoot = Join-Path $programRoot 'Microsoft Visual Studio'
    if (-not (Test-Path -LiteralPath $vsRoot -PathType Container)) { continue }
    foreach ($version in @(Get-ChildItem -LiteralPath $vsRoot -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending)) {
      foreach ($edition in @(Get-ChildItem -LiteralPath $version.FullName -Directory -ErrorAction SilentlyContinue)) {
        $candidate = Join-Path $edition.FullName 'MSBuild\Current\Bin\Roslyn\csc.exe'
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
      }
    }
  }
  return $null
}

function Find-LegacyCompiler {
  foreach ($candidate in @(
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
  )) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
  }
  return $null
}

function Supports-Deterministic([string]$Compiler) {
  $help = (& $Compiler /help 2>&1 | Out-String)
  return $help -match '(?i)(?:/|-)deterministic'
}

$compiler = Find-RoslynCompiler
if (-not $compiler) { $compiler = Find-LegacyCompiler }
if (-not $compiler) { throw 'No supported Windows C# compiler (csc.exe) was found.' }
$deterministic = Supports-Deterministic $compiler
if ($RequireDeterministic -and -not $deterministic) {
  throw 'Deterministic release build requires a Roslyn C# compiler with /deterministic support.'
}

$compileArgs = @('/nologo', '/optimize+', '/platform:x64', '/target:exe', '/debug-')
if ($deterministic) { $compileArgs += '/deterministic+' }
$source = Join-Path $root 'Program.cs'
function Compile-Helper([string]$Target) {
  New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($Target)) | Out-Null
  & $compiler @compileArgs "/out:$Target" $source
  if ($LASTEXITCODE -ne 0) { throw "path-lease helper compile failed with exit code $LASTEXITCODE" }
}

Compile-Helper $Output
if ($RequireDeterministic) {
  $probeDir = Join-Path ([IO.Path]::GetTempPath()) ('operator-path-lease-repro-' + [Guid]::NewGuid().ToString('N'))
  $probe = Join-Path $probeDir ([IO.Path]::GetFileName($Output))
  try {
    Compile-Helper $probe
    $first = (Get-FileHash -Algorithm SHA256 -LiteralPath $Output).Hash
    $second = (Get-FileHash -Algorithm SHA256 -LiteralPath $probe).Hash
    if ($first -ne $second) { throw "path-lease deterministic rebuild mismatch: $first != $second" }
    Write-Host "[operator-path-lease] deterministic sha256 $first"
  }
  finally {
    Remove-Item -LiteralPath $probeDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}

& $Output --self-test
if ($LASTEXITCODE -ne 0) { throw 'path-lease helper self-test failed' }
Write-Host "[operator-path-lease] compiler $compiler"
Write-Host "[operator-path-lease] deterministic=$deterministic"
Write-Host "[operator-path-lease] built $Output"
