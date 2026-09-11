param(
  [Parameter(Mandatory=$true)][string]$MsixPath,
  [ValidateSet('Pfx','CertificateStore','VerifyOnly')][string]$Provider = 'Pfx',
  [string]$PfxPath = '',
  [string]$PfxPassword = '',
  [string]$CertificateThumbprint = '',
  [ValidateSet('CurrentUser','LocalMachine')][string]$CertificateStoreScope = 'CurrentUser',
  [string]$TimestampUri = '',
  [switch]$SkipTimestampForTest,
  [string]$MetadataPath = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Write-Utf8NoBom([string]$Path, [string]$Value) {
  [IO.File]::WriteAllText($Path, $Value, (New-Object Text.UTF8Encoding($false)))
}

function Assert-Exit([string]$Step) {
  if ($LASTEXITCODE -ne 0) { throw "$Step failed with exit code $LASTEXITCODE" }
}

function Assert-CodeSigningCertificate($Cert, [bool]$RequirePrivateKey = $false, [bool]$RequireCurrentValidity = $true) {
  if (-not $Cert) { throw 'Signing certificate was not found.' }
  if ($RequirePrivateKey -and -not $Cert.HasPrivateKey) { throw 'Signing certificate does not expose a private key to the signing provider.' }
  if (-not $Cert.Subject) { throw 'Signing certificate has no subject.' }
  if ($RequireCurrentValidity) {
    $now = [DateTime]::UtcNow
    if ($Cert.NotBefore.ToUniversalTime() -gt $now) { throw 'Signing certificate is not yet valid.' }
    if ($Cert.NotAfter.ToUniversalTime() -le $now) { throw 'Signing certificate is expired.' }
  }
  $ekuExtension = $Cert.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.37' } | Select-Object -First 1
  if (-not $ekuExtension) { throw 'Signing certificate does not declare Enhanced Key Usage.' }
  $eku = [System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]$ekuExtension
  $codeSigning = @($eku.EnhancedKeyUsages | Where-Object { $_.Value -eq '1.3.6.1.5.5.7.3.3' })
  if ($codeSigning.Count -ne 1) { throw 'Signing certificate is not valid for Code Signing EKU.' }
}

$msix = (Resolve-Path $MsixPath).Path
if (-not $MetadataPath) { $MetadataPath = Join-Path (Split-Path $msix -Parent) 'release-metadata.json' }
$metadata = (Resolve-Path $MetadataPath).Path

if (-not $SkipTimestampForTest) {
  if (-not $TimestampUri) { throw 'Production signing verification requires an RFC 3161 TimestampUri.' }
  $timestamp = [Uri]$TimestampUri
  if (-not $timestamp.IsAbsoluteUri -or $timestamp.Scheme -ne 'https') { throw 'TimestampUri must be absolute HTTPS.' }
}

$signtool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\signtool.exe" -ErrorAction Stop | Sort-Object FullName -Descending | Select-Object -First 1
if (-not $signtool) { throw 'signtool.exe was not found in the Windows SDK.' }

switch ($Provider) {
  'Pfx' {
    if (-not $PfxPath) { throw 'Pfx provider requires PfxPath.' }
    if (-not $PfxPassword) { throw 'Pfx provider requires PfxPassword.' }
    $pfx = (Resolve-Path $PfxPath).Path
    $args = @('sign', '/fd', 'SHA256', '/f', $pfx, '/p', $PfxPassword)
    if (-not $SkipTimestampForTest) { $args += @('/tr', $TimestampUri, '/td', 'SHA256') }
    $args += $msix
    & $signtool.FullName @args
    Assert-Exit 'SignTool PFX sign'
  }
  'CertificateStore' {
    $thumb = ($CertificateThumbprint -replace '\s','').ToUpperInvariant()
    if ($thumb -notmatch '^[0-9A-F]{40}$') { throw 'CertificateStore provider requires a 40-hex SHA-1 CertificateThumbprint.' }
    $storePath = "Cert:\$CertificateStoreScope\My\$thumb"
    $cert = Get-Item -LiteralPath $storePath -ErrorAction Stop
    Assert-CodeSigningCertificate $cert $true $true
    $args = @('sign', '/fd', 'SHA256')
    if ($CertificateStoreScope -eq 'LocalMachine') { $args += '/sm' }
    $args += @('/s', 'My', '/sha1', $thumb)
    if (-not $SkipTimestampForTest) { $args += @('/tr', $TimestampUri, '/td', 'SHA256') }
    $args += $msix
    & $signtool.FullName @args
    Assert-Exit 'SignTool certificate-store sign'
  }
  'VerifyOnly' {
    Write-Host '[operator-release] verify-only provider: package must already be signed by an external provider'
  }
  default { throw "Unsupported signing provider '$Provider'." }
}

& $signtool.FullName verify /pa /all /v $msix
Assert-Exit 'SignTool verify'

$signature = Get-AuthenticodeSignature -FilePath $msix
if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
  throw "Authenticode verification is not Valid: $($signature.Status) $($signature.StatusMessage)"
}
Assert-CodeSigningCertificate $signature.SignerCertificate $false $false
$subject = $signature.SignerCertificate.Subject
$fingerprint = $signature.SignerCertificate.GetCertHashString([System.Security.Cryptography.HashAlgorithmName]::SHA256).ToLowerInvariant()
$hasTimestamp = $null -ne $signature.TimeStamperCertificate
if (-not $SkipTimestampForTest -and -not $hasTimestamp) { throw 'Production MSIX signature does not contain a verifiable timestamp.' }
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
if ($meta.PSObject.Properties.Name -contains 'signerCertificateSha256') { $meta.signerCertificateSha256 = $fingerprint } else { $meta | Add-Member -NotePropertyName signerCertificateSha256 -NotePropertyValue $fingerprint }
if ($meta.PSObject.Properties.Name -contains 'timestamped') { $meta.timestamped = $hasTimestamp } else { $meta | Add-Member -NotePropertyName timestamped -NotePropertyValue $hasTimestamp }
$meta.sha256 = (Get-FileHash -LiteralPath $msix -Algorithm SHA256).Hash.ToLowerInvariant()
$meta.sizeBytes = (Get-Item -LiteralPath $msix).Length
Write-Utf8NoBom $metadata ($meta | ConvertTo-Json -Depth 8)

Write-Host "[operator-release] verified $msix"
Write-Host "[operator-release] provider $Provider"
Write-Host "[operator-release] signer $subject"
Write-Host "[operator-release] sha256 $($meta.sha256)"
