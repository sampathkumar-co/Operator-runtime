param(
  [string]$Version = '1.0.0.0',
  [string]$Publisher = 'CN=6F726FAE-9AD9-4643-A991-7E86CBD7C967',
  [string]$IdentityName = 'SPLCART.SplcartOperator',
  [string]$UpdateBaseUri = 'https://updates.example.invalid/operator',
  [string]$OutputDir = '',
  [string]$NodeExe = '',
  [string]$MakeAppxExe = '',
  [string]$AuditPrebuiltNativeDir = '',
  [string]$AuditLauncherSha256 = '',
  [string]$AuditUiaSha256 = '',
  [string]$AuditDpapiSha256 = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-Exit([string]$Step) {
  if ($LASTEXITCODE -ne 0) { throw "$Step failed with exit code $LASTEXITCODE" }
}

function Write-Utf8NoBom([string]$Path, [string]$Value) {
  [IO.File]::WriteAllText($Path, $Value, (New-Object Text.UTF8Encoding($false)))
}

function Escape-Xml([string]$Value) {
  return [System.Security.SecurityElement]::Escape($Value)
}

function New-Logo([string]$Path, [int]$Size) {
  Add-Type -AssemblyName System.Drawing
  $bitmap = New-Object System.Drawing.Bitmap $Size, $Size
  try {
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
      $graphics.Clear([System.Drawing.Color]::FromArgb(255, 32, 32, 32))
      $fontSize = [Math]::Max(10, [int]($Size * 0.42))
      $font = New-Object System.Drawing.Font 'Segoe UI', $fontSize, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
      try {
        $brush = [System.Drawing.Brushes]::White
        $format = New-Object System.Drawing.StringFormat
        $format.Alignment = [System.Drawing.StringAlignment]::Center
        $format.LineAlignment = [System.Drawing.StringAlignment]::Center
        $graphics.DrawString('O', $font, $brush, (New-Object System.Drawing.RectangleF 0, 0, $Size, $Size), $format)
      } finally { $font.Dispose() }
    } finally { $graphics.Dispose() }
    $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally { $bitmap.Dispose() }
}

if ($Version -notmatch '^\d+\.\d+\.\d+\.\d+$') { throw 'Version must be a four-part MSIX version such as 0.1.0.0.' }
$base = [Uri]$UpdateBaseUri
if ($base.Scheme -ne 'https' -or -not $base.IsAbsoluteUri -or $base.UserInfo -or $base.Query -or $base.Fragment) { throw 'UpdateBaseUri must be a credential-free absolute HTTPS URI without query or fragment.' }

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if (-not $OutputDir) { $OutputDir = Join-Path $repo 'artifacts\windows-release' }
elseif (-not [IO.Path]::IsPathRooted($OutputDir)) { $OutputDir = Join-Path $repo $OutputDir }
$OutputDir = [IO.Path]::GetFullPath($OutputDir)
$stage = Join-Path $OutputDir 'staging'
Remove-Item -LiteralPath $OutputDir -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $stage, (Join-Path $stage 'runtime'), (Join-Path $stage 'app'), (Join-Path $stage 'native'), (Join-Path $stage 'Assets') | Out-Null

if (-not $NodeExe) { $NodeExe = (Get-Command node.exe -ErrorAction Stop).Source }
$NodeExe = (Resolve-Path $NodeExe).Path
if (-not (Test-Path -LiteralPath $NodeExe -PathType Leaf)) { throw 'NodeExe is not a file.' }
$certifiedNodeVersion = 'v22.23.2'
$certifiedNodeSha256 = '0d0f5e39f9f3d9587bc19f73eab3c2c9c4903fd02d6dbf9c853dd81b3d95fad4'
$nodeVersion = (& $NodeExe --version).Trim()
Assert-Exit 'Node runtime version query'
if ($nodeVersion -ne $certifiedNodeVersion) { throw "NodeExe must be the certified $certifiedNodeVersion runtime; got $nodeVersion." }
$nodeSha256 = (Get-FileHash -LiteralPath $NodeExe -Algorithm SHA256).Hash.ToLowerInvariant()
if ($nodeSha256 -ne $certifiedNodeSha256) { throw 'NodeExe SHA-256 does not match the certified Windows x64 Node runtime.' }
$npmCli = Join-Path (Split-Path -Parent $NodeExe) 'node_modules\npm\bin\npm-cli.js'
if (-not (Test-Path -LiteralPath $npmCli -PathType Leaf)) { throw 'Certified Node distribution is missing npm-cli.js.' }

$auditHashArgs = @($AuditLauncherSha256, $AuditUiaSha256, $AuditDpapiSha256)
$useAuditPrebuiltNative = -not [string]::IsNullOrWhiteSpace($AuditPrebuiltNativeDir)
if (-not $useAuditPrebuiltNative -and ($auditHashArgs | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })) {
  throw 'Audit native hashes require -AuditPrebuiltNativeDir.'
}
if ($useAuditPrebuiltNative) {
  if ($env:CI) { throw 'AuditPrebuiltNativeDir is local-audit-only and must not be used in CI.' }
  foreach ($expectedHash in $auditHashArgs) {
    if ($expectedHash -notmatch '^[0-9a-fA-F]{64}$') { throw 'All audit native SHA-256 values are required and must be 64 hex characters.' }
  }
  $AuditPrebuiltNativeDir = (Resolve-Path $AuditPrebuiltNativeDir).Path
  $launcher = Join-Path $AuditPrebuiltNativeDir 'operator-windows-launcher.exe'
  $uia = Join-Path $AuditPrebuiltNativeDir 'operator-windows-uia.exe'
  $dpapi = Join-Path $AuditPrebuiltNativeDir 'operator-windows-dpapi.exe'
  $auditNative = @(@($launcher, $AuditLauncherSha256), @($uia, $AuditUiaSha256), @($dpapi, $AuditDpapiSha256))
  foreach ($entry in $auditNative) {
    if (-not (Test-Path -LiteralPath $entry[0] -PathType Leaf)) { throw "Required audit native file missing: $($entry[0])" }
    $actualHash = (Get-FileHash -LiteralPath $entry[0] -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $entry[1].ToLowerInvariant()) { throw "Audit native SHA-256 mismatch: $($entry[0])" }
  }
  Write-Host '[operator-release] using hash-verified local-audit native binaries; CI/source-build path remains unchanged'
} else {
  $rustcVersion = (& rustc --version).Trim()
  Assert-Exit 'Rust compiler version query'
  if ($rustcVersion -notmatch '^rustc 1\.98\.1 ') { throw "Release build requires certified rustc 1.98.1; got $rustcVersion." }

  Write-Host '[operator-release] compiling native launcher from committed Cargo.lock'
  & cargo build --locked --manifest-path (Join-Path $repo 'native\windows-launcher\Cargo.toml') --release
  Assert-Exit 'windows launcher build'
  Write-Host '[operator-release] compiling Windows UIA sidecar from committed Cargo.lock'
  & cargo build --locked --manifest-path (Join-Path $repo 'native\windows-uia\Cargo.toml') --release
  Assert-Exit 'windows UIA build'
  Write-Host '[operator-release] compiling Windows DPAPI helper from committed Cargo.lock'
  & cargo build --locked --manifest-path (Join-Path $repo 'native\windows-dpapi\Cargo.toml') --release
  Assert-Exit 'windows DPAPI build'
  $launcher = Join-Path $repo 'native\windows-launcher\target\release\operator-windows-launcher.exe'
  $uia = Join-Path $repo 'native\windows-uia\target\release\operator-windows-uia.exe'
  $dpapi = Join-Path $repo 'native\windows-dpapi\target\release\operator-windows-dpapi.exe'
}

Write-Host '[operator-release] compiling Windows path-lease helper'
& (Join-Path $repo 'native\windows-path-lease\build.ps1')
Assert-Exit 'windows path-lease build'

$pathLease = Join-Path $repo 'native\windows-path-lease\target\release\operator-windows-path-lease.exe'
foreach ($file in @($launcher, $uia, $dpapi, $pathLease, $NodeExe)) {
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Required release file missing: $file" }
}

Copy-Item -LiteralPath $launcher -Destination (Join-Path $stage 'Operator.exe')
Copy-Item -LiteralPath $NodeExe -Destination (Join-Path $stage 'runtime\node.exe')
Copy-Item -LiteralPath $uia -Destination (Join-Path $stage 'native\operator-windows-uia.exe')
Copy-Item -LiteralPath $dpapi -Destination (Join-Path $stage 'native\operator-windows-dpapi.exe')
Copy-Item -LiteralPath $pathLease -Destination (Join-Path $stage 'native\operator-windows-path-lease.exe')

$mcpDeps = Join-Path $OutputDir 'mcp-runtime-deps'
New-Item -ItemType Directory -Force -Path $mcpDeps | Out-Null
Copy-Item -LiteralPath (Join-Path $repo 'apps\mcp-server\package.json') -Destination (Join-Path $mcpDeps 'package.json')
Copy-Item -LiteralPath (Join-Path $repo 'apps\mcp-server\package-lock.json') -Destination (Join-Path $mcpDeps 'package-lock.json')
Write-Host '[operator-release] installing locked MCP production dependencies in isolated staging'
& $NodeExe $npmCli ci --ignore-scripts --omit=dev --prefix $mcpDeps
Assert-Exit 'MCP production dependency install'

$nonRuntimeDependencyDirs = @('test', 'tests', 'fixtures', 'benchmark', 'benchmarks', '.github')
$dependencyRoot = Join-Path $mcpDeps 'node_modules'
Get-ChildItem -LiteralPath $dependencyRoot -Directory -Recurse -Force |
  Where-Object { $nonRuntimeDependencyDirs -contains $_.Name } |
  Sort-Object { $_.FullName.Length } -Descending |
  ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force }
Write-Host '[operator-release] pruned non-runtime test/benchmark metadata from production dependencies'

Copy-Item -LiteralPath (Join-Path $repo 'package.json') -Destination (Join-Path $stage 'app\package.json')
Copy-Item -LiteralPath (Join-Path $repo 'src') -Destination (Join-Path $stage 'app\src') -Recurse
New-Item -ItemType Directory -Force -Path (Join-Path $stage 'app\apps\local-agent') | Out-Null
Copy-Item -LiteralPath (Join-Path $repo 'apps\local-agent\src') -Destination (Join-Path $stage 'app\apps\local-agent\src') -Recurse
New-Item -ItemType Directory -Force -Path (Join-Path $stage 'app\apps\mcp-server') | Out-Null
Copy-Item -LiteralPath (Join-Path $repo 'apps\mcp-server\src') -Destination (Join-Path $stage 'app\apps\mcp-server\src') -Recurse
Copy-Item -LiteralPath (Join-Path $repo 'apps\mcp-server\package.json') -Destination (Join-Path $stage 'app\apps\mcp-server\package.json')
Copy-Item -LiteralPath (Join-Path $repo 'apps\mcp-server\package-lock.json') -Destination (Join-Path $stage 'app\apps\mcp-server\package-lock.json')
Copy-Item -LiteralPath (Join-Path $mcpDeps 'node_modules') -Destination (Join-Path $stage 'app\apps\mcp-server\node_modules') -Recurse
Remove-Item -LiteralPath $mcpDeps -Recurse -Force

New-Logo (Join-Path $stage 'Assets\Square44x44Logo.png') 44
New-Logo (Join-Path $stage 'Assets\Square150x150Logo.png') 150
New-Logo (Join-Path $stage 'Assets\StoreLogo.png') 50

$identityXml = Escape-Xml $IdentityName
$publisherXml = Escape-Xml $Publisher
$manifest = @"
<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
         xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
         xmlns:uap10="http://schemas.microsoft.com/appx/manifest/uap/windows10/10"
         xmlns:uap5="http://schemas.microsoft.com/appx/manifest/uap/windows10/5"
         xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
         IgnorableNamespaces="uap uap5 uap10 rescap">
  <Identity Name="$identityXml" Publisher="$publisherXml" Version="$Version" ProcessorArchitecture="x64" />
  <Properties>
    <DisplayName>SPLCART Operator</DisplayName>
    <PublisherDisplayName>SPLCART</PublisherDisplayName>
    <Description>Semantic execution runtime for user-authorized computers.</Description>
    <Logo>Assets\StoreLogo.png</Logo>
    <uap10:PackageIntegrity><uap10:Content Enforcement="on" /></uap10:PackageIntegrity>
  </Properties>
  <Resources><Resource Language="en-us" /></Resources>
  <Dependencies><TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.19041.0" MaxVersionTested="10.0.26100.0" /></Dependencies>
  <Applications>
    <Application Id="Operator" Executable="Operator.exe" uap10:RuntimeBehavior="packagedClassicApp" uap10:TrustLevel="mediumIL">
      <uap:VisualElements DisplayName="SPLCART Operator" Description="Operate authorized computers through semantic, policy-gated capabilities."
                          BackgroundColor="transparent" Square44x44Logo="Assets\Square44x44Logo.png" Square150x150Logo="Assets\Square150x150Logo.png" />
      <Extensions>
        <uap5:Extension Category="windows.appExecutionAlias">
          <uap5:AppExecutionAlias>
            <uap5:ExecutionAlias Alias="operator.exe" />
          </uap5:AppExecutionAlias>
        </uap5:Extension>
      </Extensions>
    </Application>
  </Applications>
  <Capabilities><rescap:Capability Name="runFullTrust" /></Capabilities>
</Package>
"@
Write-Utf8NoBom (Join-Path $stage 'AppxManifest.xml') $manifest

if ($MakeAppxExe) {
  $MakeAppxExe = (Resolve-Path $MakeAppxExe).Path
  if (-not (Test-Path -LiteralPath $MakeAppxExe -PathType Leaf)) { throw 'MakeAppxExe is not a file.' }
  $makeAppx = Get-Item -LiteralPath $MakeAppxExe
} else {
  $makeAppx = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\makeappx.exe" -ErrorAction Stop | Sort-Object FullName -Descending | Select-Object -First 1
  if (-not $makeAppx) { throw 'makeappx.exe was not found in the Windows SDK; pass -MakeAppxExe to a verified SDK BuildTools copy.' }
}
$msixName = "Operator-$Version-x64.msix"
$msixPath = Join-Path $OutputDir $msixName
Write-Host "[operator-release] packing $msixName"
& $makeAppx.FullName pack /d $stage /p $msixPath /o
Assert-Exit 'MakeAppx pack'

$baseText = $UpdateBaseUri.TrimEnd('/')
$appInstallerUri = "$baseText/Operator.appinstaller"
$msixUri = "$baseText/$msixName"
$appInstaller = @"
<?xml version="1.0" encoding="utf-8"?>
<AppInstaller xmlns="http://schemas.microsoft.com/appx/appinstaller/2021" Uri="$appInstallerUri" Version="$Version">
  <MainPackage Name="$identityXml" Publisher="$publisherXml" Version="$Version" ProcessorArchitecture="x64" Uri="$msixUri" />
  <UpdateSettings>
    <OnLaunch HoursBetweenUpdateChecks="6" ShowPrompt="true" UpdateBlocksActivation="false" />
  </UpdateSettings>
</AppInstaller>
"@
$appInstallerPath = Join-Path $OutputDir 'Operator.appinstaller'
Write-Utf8NoBom $appInstallerPath $appInstaller

$hash = (Get-FileHash -LiteralPath $msixPath -Algorithm SHA256).Hash.ToLowerInvariant()
$size = (Get-Item -LiteralPath $msixPath).Length
$metadata = [ordered]@{
  schemaVersion = 1
  product = 'operator-runtime'
  version = $Version
  platform = 'win32'
  arch = 'x64'
  identityName = $IdentityName
  artifact = $msixName
  sha256 = $hash
  sizeBytes = $size
  signed = $false
  publisher = $Publisher
  appInstaller = 'Operator.appinstaller'
}
Write-Utf8NoBom (Join-Path $OutputDir 'release-metadata.json') ($metadata | ConvertTo-Json -Depth 5)

Write-Host "[operator-release] built $msixPath"
Write-Host "[operator-release] sha256 $hash"
