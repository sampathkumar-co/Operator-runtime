param(
  [string]$Version = '0.1.0.0',
  [string]$Publisher = 'CN=Operator Development',
  [string]$IdentityName = 'Operator.Runtime',
  [string]$UpdateBaseUri = 'https://updates.example.invalid/operator',
  [string]$OutputDir = '',
  [string]$NodeExe = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-Exit([string]$Step) {
  if ($LASTEXITCODE -ne 0) { throw "$Step failed with exit code $LASTEXITCODE" }
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
if ($base.Scheme -ne 'https' -or -not $base.IsAbsoluteUri -or $base.UserInfo) { throw 'UpdateBaseUri must be a credential-free absolute HTTPS URI.' }

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if (-not $OutputDir) { $OutputDir = Join-Path $repo 'artifacts\windows-release' }
$OutputDir = [IO.Path]::GetFullPath($OutputDir)
$stage = Join-Path $OutputDir 'staging'
Remove-Item -LiteralPath $OutputDir -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $stage, (Join-Path $stage 'runtime'), (Join-Path $stage 'app'), (Join-Path $stage 'native'), (Join-Path $stage 'Assets') | Out-Null

if (-not $NodeExe) { $NodeExe = (Get-Command node.exe -ErrorAction Stop).Source }
$NodeExe = (Resolve-Path $NodeExe).Path
if (-not (Test-Path -LiteralPath $NodeExe -PathType Leaf)) { throw 'NodeExe is not a file.' }

Write-Host '[operator-release] compiling native launcher'
& cargo build --manifest-path (Join-Path $repo 'native\windows-launcher\Cargo.toml') --release
Assert-Exit 'windows launcher build'
Write-Host '[operator-release] compiling Windows UIA sidecar'
& cargo build --manifest-path (Join-Path $repo 'native\windows-uia\Cargo.toml') --release
Assert-Exit 'windows UIA build'

$launcher = Join-Path $repo 'native\windows-launcher\target\release\operator-windows-launcher.exe'
$uia = Join-Path $repo 'native\windows-uia\target\release\operator-windows-uia.exe'
foreach ($file in @($launcher, $uia, $NodeExe)) {
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Required release file missing: $file" }
}

Copy-Item -LiteralPath $launcher -Destination (Join-Path $stage 'Operator.exe')
Copy-Item -LiteralPath $NodeExe -Destination (Join-Path $stage 'runtime\node.exe')
Copy-Item -LiteralPath $uia -Destination (Join-Path $stage 'native\operator-windows-uia.exe')
Copy-Item -LiteralPath (Join-Path $repo 'package.json') -Destination (Join-Path $stage 'app\package.json')
Copy-Item -LiteralPath (Join-Path $repo 'src') -Destination (Join-Path $stage 'app\src') -Recurse
New-Item -ItemType Directory -Force -Path (Join-Path $stage 'app\apps\local-agent') | Out-Null
Copy-Item -LiteralPath (Join-Path $repo 'apps\local-agent\src') -Destination (Join-Path $stage 'app\apps\local-agent\src') -Recurse

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
         xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
         IgnorableNamespaces="uap uap10 rescap">
  <Identity Name="$identityXml" Publisher="$publisherXml" Version="$Version" ProcessorArchitecture="x64" />
  <Properties>
    <DisplayName>Operator</DisplayName>
    <PublisherDisplayName>Operator</PublisherDisplayName>
    <Description>Semantic execution runtime for user-authorized computers.</Description>
    <Logo>Assets\StoreLogo.png</Logo>
  </Properties>
  <Resources><Resource Language="en-us" /></Resources>
  <Dependencies><TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.19041.0" MaxVersionTested="10.0.26100.0" /></Dependencies>
  <Applications>
    <Application Id="Operator" Executable="Operator.exe" uap10:RuntimeBehavior="packagedClassicApp" uap10:TrustLevel="mediumIL">
      <uap:VisualElements DisplayName="Operator" Description="Operate authorized computers through semantic, policy-gated capabilities."
                          BackgroundColor="transparent" Square44x44Logo="Assets\Square44x44Logo.png" Square150x150Logo="Assets\Square150x150Logo.png" />
    </Application>
  </Applications>
  <Capabilities><rescap:Capability Name="runFullTrust" /></Capabilities>
</Package>
"@
Set-Content -LiteralPath (Join-Path $stage 'AppxManifest.xml') -Value $manifest -Encoding utf8NoBOM

$makeAppx = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\makeappx.exe" -ErrorAction Stop | Sort-Object FullName -Descending | Select-Object -First 1
if (-not $makeAppx) { throw 'makeappx.exe was not found in the Windows SDK.' }
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
Set-Content -LiteralPath $appInstallerPath -Value $appInstaller -Encoding utf8NoBOM

$hash = (Get-FileHash -LiteralPath $msixPath -Algorithm SHA256).Hash.ToLowerInvariant()
$size = (Get-Item -LiteralPath $msixPath).Length
$metadata = [ordered]@{
  schemaVersion = 1
  product = 'operator-runtime'
  version = $Version
  platform = 'win32'
  arch = 'x64'
  artifact = $msixName
  sha256 = $hash
  sizeBytes = $size
  signed = $false
  publisher = $Publisher
  appInstaller = 'Operator.appinstaller'
}
$metadata | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $OutputDir 'release-metadata.json') -Encoding utf8NoBOM

Write-Host "[operator-release] built $msixPath"
Write-Host "[operator-release] sha256 $hash"
