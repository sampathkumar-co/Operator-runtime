param(
  [Parameter(Mandatory=$true)][string]$MsixPath,
  [Parameter(Mandatory=$true)][string]$PfxPath,
  [Parameter(Mandatory=$true)][string]$PfxPassword,
  [string]$TimestampUri = '',
  [switch]$SkipTimestampForTest,
  [string]$MetadataPath = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-Exit([string]$Step) {
  if ($LASTEXITCODE -ne 0) { throw "$Step failed with exit code $LASTEXITCODE" }
}

$msix = (Resolve-Path $MsixPath).Path
$pfx = (Resolve-Path $PfxPath).Path
if (-not $MetadataPath) { $MetadataPath = Join-Path (Split-Path $msix -Parent) 'release-metadata.json' }
$metadata = (Resolve-Path $MetadataPath).Path

if (-not $SkipTimestampForTest) {
  if (-not $TimestampUri) { throw 'Production signing requires an RFC 3161 TimestampUri.' }
  $timestamp = [Uri]$TimestampUri
  if (-not $timestamp.IsAbsoluteUri -or $timestamp.Scheme -ne 'https') { throw 'TimestampUri must be absolute HTTPS.' }
}

$signtool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\signtool.exe" -ErrorAction Stop | Sort-Object FullName -Descending | Select-Object -First 1
if (-not $signtool) { throw 'signtool.exe was not found in the Windows SDK.' }

$args = @('sign', '/fd', 'SHA256', '/f', $pfx, '/p', $PfxPassword)
if (-not $SkipTimestampForTest) { $args += @('/tr', $TimestampUri, '/td', 'SHA256') }
$args += $msix
& $signtool.FullName @args
Assert-Exit 'SignTool sign'

& $signtool.FullName verify /pa /all /v $msix
Assert-Exit 'SignTool verify'

$signature = Get-AuthenticodeSignature -FilePath $msix
if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
  throw "Authenticode verification is not Valid: $($signature.Status) $($signature.StatusMessage)"
}
$subject = $signature.SignerCertificate.Subject
if (-not $subject) { throw 'Signed MSIX did not expose a signer subject.' }

[xml]$manifest = & {
  $makeAppx = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\makeappx.exe" -ErrorAction Stop | Sort-Object FullName -Descending | Select-Object -First 1
  $temp = Join-Path $env:RUNNER_TEMP ("operator-sign-verify-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path $temp | Out-Null
  try {
    & $makeAppx.FullName unpack /p $msix /d $temp /o | Out-Null
    Assert-Exit 'MakeAppx unpack signed package'
    Get-Content (Join-Path $temp 'AppxManifest.xml') -Raw
  } finally { Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue }
}
$publisher = [string]$manifest.Package.Identity.Publisher
if ($publisher -ne $subject) { throw "MSIX manifest publisher '$publisher' does not match signing certificate subject '$subject'." }

$meta = Get-Content $metadata -Raw | ConvertFrom-Json
$meta.signed = $true
if ($meta.PSObject.Properties.Name -contains 'signerSubject') { $meta.signerSubject = $subject } else { $meta | Add-Member -NotePropertyName signerSubject -NotePropertyValue $subject }
if ($meta.PSObject.Properties.Name -contains 'timestamped') { $meta.timestamped = (-not $SkipTimestampForTest) } else { $meta | Add-Member -NotePropertyName timestamped -NotePropertyValue (-not $SkipTimestampForTest) }
$meta.sha256 = (Get-FileHash -LiteralPath $msix -Algorithm SHA256).Hash.ToLowerInvariant()
$meta.sizeBytes = (Get-Item -LiteralPath $msix).Length
$meta | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $metadata -Encoding utf8NoBOM

Write-Host "[operator-release] signed $msix"
Write-Host "[operator-release] signer $subject"
Write-Host "[operator-release] sha256 $($meta.sha256)"
