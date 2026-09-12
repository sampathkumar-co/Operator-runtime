import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

function psQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function windowsPowerShellEnvironment(sourceEnv = process.env) {
  const env = { ...sourceEnv };
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'psmodulepath') delete env[key];
  }
  return env;
}

async function runPowerShell(script) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return await new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      shell: false,
      windowsHide: true,
      env: windowsPowerShellEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code, signal) => {
      const out = Buffer.concat(stdout).toString('utf8').trim();
      const err = Buffer.concat(stderr).toString('utf8').trim();
      if (signal) reject(new Error(`PowerShell terminated by signal ${signal}.`));
      else if (code !== 0) reject(new Error(err || out || `PowerShell exited ${code}.`));
      else resolve(out);
    });
  });
}

export function assertSupportedWindows() {
  if (process.platform !== 'win32') throw new Error('operator-runtime-cli currently supports Windows only.');
  if (process.arch !== 'x64') throw new Error(`operator-runtime-cli currently requires Windows x64; received ${process.arch}.`);
}

export async function verifyAuthenticode(msixPath) {
  const file = path.resolve(msixPath);
  const script = `
$ErrorActionPreference = 'Stop'
$sig = Get-AuthenticodeSignature -LiteralPath ${psQuote(file)}
if ($sig.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
  throw "MSIX Authenticode signature is not valid: $($sig.Status)"
}
$cert = $sig.SignerCertificate
if (-not $cert) { throw 'MSIX signer certificate is missing.' }
$fingerprint = $cert.GetCertHashString([System.Security.Cryptography.HashAlgorithmName]::SHA256).ToLowerInvariant()
$timestamped = $null -ne $sig.TimeStamperCertificate
[ordered]@{ subject = $cert.Subject; certificateSha256 = $fingerprint; timestamped = $timestamped } | ConvertTo-Json -Compress
`;
  return JSON.parse(await runPowerShell(script));
}

export function requireSignatureMatchesMetadata(signature, metadata) {
  const actual = String(signature?.certificateSha256 ?? '').toLowerCase();
  if (actual !== metadata.signerCertificateSha256) throw new Error('MSIX signer certificate does not match release metadata.');
  if (String(signature?.subject ?? '') !== metadata.signerSubject) throw new Error('MSIX signer subject does not match release metadata.');
  if (metadata.timestamped === true && signature?.timestamped !== true) throw new Error('MSIX signature does not contain a verifiable timestamp.');
}

export function requireTrustedSigner(signature, trustedSigners) {
  const fingerprint = String(signature?.certificateSha256 ?? '').toLowerCase();
  const match = trustedSigners.find((entry) => entry.certificateSha256 === fingerprint);
  if (!match) throw new Error(`MSIX signer certificate is not trusted by this bootstrap version (${fingerprint || 'missing fingerprint'}).`);
  if (String(signature.subject) !== match.subject) throw new Error('MSIX signer subject does not match the pinned signer record.');
  return match;
}

export async function verifyInstalledOperatorSignature(packageInfo) {
  const signatureFile = path.join(packageInfo.installLocation, 'AppxSignature.p7x');
  const script = `
$ErrorActionPreference = 'Stop'
$bytes = [IO.File]::ReadAllBytes(${psQuote(signatureFile)})
if ($bytes.Length -le 4 -or $bytes[0] -ne 0x50 -or $bytes[1] -ne 0x4b -or $bytes[2] -ne 0x43 -or $bytes[3] -ne 0x58) {
  throw 'Installed AppxSignature.p7x has an invalid PKCX header.'
}
Add-Type -AssemblyName System.Security
$payload = New-Object byte[] ($bytes.Length - 4)
[Array]::Copy($bytes, 4, $payload, 0, $payload.Length)
$cms = New-Object System.Security.Cryptography.Pkcs.SignedCms
$cms.Decode($payload)
$cms.CheckSignature($true)
if ($cms.SignerInfos.Count -ne 1 -or -not $cms.SignerInfos[0].Certificate) { throw 'Installed package signer certificate is missing or ambiguous.' }
$cert = $cms.SignerInfos[0].Certificate
$fingerprint = $cert.GetCertHashString([System.Security.Cryptography.HashAlgorithmName]::SHA256).ToLowerInvariant()
[ordered]@{ subject = $cert.Subject; certificateSha256 = $fingerprint } | ConvertTo-Json -Compress
`;
  return JSON.parse(await runPowerShell(script));
}

export async function getInstalledOperatorPackage() {
  const script = `
$ErrorActionPreference = 'Stop'
$p = Get-AppxPackage -Name 'Operator.Runtime' | Sort-Object Version -Descending | Select-Object -First 1
if ($p) {
  [ordered]@{ version = [string]$p.Version; publisher = [string]$p.Publisher; installLocation = [string]$p.InstallLocation } | ConvertTo-Json -Compress
}
`;
  const out = await runPowerShell(script);
  return out ? JSON.parse(out) : null;
}

function compareVersion(a, b) {
  const aa = String(a).split('.').map(Number);
  const bb = String(b).split('.').map(Number);
  for (let i = 0; i < 4; i += 1) {
    if (aa[i] !== bb[i]) return aa[i] < bb[i] ? -1 : 1;
  }
  return 0;
}

export async function installVerifiedMsix(msixPath, metadata, signature) {
  const existing = await getInstalledOperatorPackage();
  if (existing) {
    const relation = compareVersion(existing.version, metadata.version);
    if (relation > 0) throw new Error(`A newer Operator ${existing.version} is already installed; refusing downgrade to ${metadata.version}.`);
    if (relation === 0) {
      const installedSignature = await verifyInstalledOperatorSignature(existing);
      if (installedSignature.certificateSha256 !== signature.certificateSha256 || installedSignature.subject !== signature.subject) {
        throw new Error('Installed Operator signer does not match the verified release package.');
      }
      return { ...existing, installedNow: false };
    }
  }
  const script = `
$ErrorActionPreference = 'Stop'
try {
  Add-AppxPackage -Path ${psQuote(path.resolve(msixPath))}
} catch {
  $message = $_ | Out-String
  $activityId = $null
  if ($_.Exception -and $_.Exception.PSObject.Properties.Name -contains 'ActivityId') { $activityId = $_.Exception.ActivityId }
  if (-not $activityId -and $_.ErrorDetails -and $_.ErrorDetails.Message -match 'ActivityId:\s*([0-9a-fA-F-]{36})') { $activityId = $Matches[1] }
  if ($activityId) {
    $deployment = Get-AppPackageLog -ActivityID $activityId | Format-List * | Out-String
    throw ($message + [Environment]::NewLine + '[operator-appx-deployment-log]' + [Environment]::NewLine + $deployment)
  }
  throw $message
}
`;
  await runPowerShell(script);
  const installed = await getInstalledOperatorPackage();
  if (!installed || installed.version !== metadata.version) throw new Error('Operator installation did not register the expected package version.');
  if (installed.publisher !== signature.subject) throw new Error('Installed Operator publisher does not match the verified package signer.');
  const installedSignature = await verifyInstalledOperatorSignature(installed);
  if (installedSignature.certificateSha256 !== signature.certificateSha256 || installedSignature.subject !== signature.subject) {
    throw new Error('Installed Operator signature does not match the verified release package.');
  }
  return { ...installed, installedNow: true };
}

async function runLauncher(launcher, args) {
  await fs.access(launcher);
  return await new Promise((resolve, reject) => {
    const child = spawn(launcher, args, { shell: false, windowsHide: false, stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (signal) reject(new Error(`Operator launcher terminated by signal ${signal}.`));
      else if (code !== 0) reject(new Error(`Operator launcher exited with code ${code}.`));
      else resolve();
    });
  });
}

export async function runOperatorSetup(packageInfo, root) {
  const launcher = path.join(packageInfo.installLocation, 'Operator.exe');
  await runLauncher(launcher, ['setup', '--root', path.resolve(root)]);
}

export async function runOperatorVerify(packageInfo) {
  const launcher = path.join(packageInfo.installLocation, 'Operator.exe');
  await runLauncher(launcher, ['verify']);
}

export async function uninstallOperatorPackage() {
  const out = await runPowerShell(`
$ErrorActionPreference = 'Stop'

function Get-OperatorOwnedProcesses([string]$RuntimeNode, [string]$Launcher) {
  $owned = @()
  foreach ($candidate in @(Get-Process -Name node,Operator -ErrorAction SilentlyContinue)) {
    try {
      $candidatePath = [string]$candidate.Path
      if (
        [string]::Equals($candidatePath, $RuntimeNode, [System.StringComparison]::OrdinalIgnoreCase) -or
        [string]::Equals($candidatePath, $Launcher, [System.StringComparison]::OrdinalIgnoreCase)
      ) {
        $owned += $candidate
      }
    } catch {
      # Unrelated processes may not expose Path. They are not Operator-owned.
    }
  }
  return @($owned)
}

$packages = @(Get-AppxPackage -Name 'Operator.Runtime')
foreach ($package in $packages) {
  $runtimeNode = Join-Path $package.InstallLocation 'runtime\node.exe'
  $launcher = Join-Path $package.InstallLocation 'Operator.exe'

  $processDeadline = [DateTime]::UtcNow.AddSeconds(15)
  do {
    $ownedProcesses = @(Get-OperatorOwnedProcesses -RuntimeNode $runtimeNode -Launcher $launcher)
    foreach ($process in $ownedProcesses) {
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    }
    if ($ownedProcesses.Count -eq 0) { break }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $processDeadline)

  $remainingOwned = @(Get-OperatorOwnedProcesses -RuntimeNode $runtimeNode -Launcher $launcher)
  if ($remainingOwned.Count -gt 0) {
    $remainingPids = ($remainingOwned | ForEach-Object { [string]$_.Id }) -join ','
    throw "Operator Runtime processes did not exit before uninstall. Remaining PID(s): $remainingPids"
  }

  try {
    Remove-AppxPackage -Package $package.PackageFullName -ErrorAction Stop
  } catch {
    $message = $_ | Out-String
    $activityId = $null
    if ($_.Exception -and $_.Exception.PSObject.Properties.Name -contains 'ActivityId') { $activityId = $_.Exception.ActivityId }
    if (-not $activityId -and $_.ErrorDetails -and $_.ErrorDetails.Message -match 'ActivityId:\s*([0-9a-fA-F-]{36})') { $activityId = $Matches[1] }
    if ($activityId) {
      $deployment = Get-AppPackageLog -ActivityID $activityId | Format-List * | Out-String
      throw ($message + [Environment]::NewLine + '[operator-appx-uninstall-log]' + [Environment]::NewLine + $deployment)
    }
    throw $message
  }
}

$registrationDeadline = [DateTime]::UtcNow.AddSeconds(20)
do {
  $remainingPackages = @(Get-AppxPackage -Name 'Operator.Runtime' -ErrorAction SilentlyContinue)
  if ($remainingPackages.Count -eq 0) { break }
  Start-Sleep -Milliseconds 250
} while ([DateTime]::UtcNow -lt $registrationDeadline)

if ($remainingPackages.Count -gt 0) {
  $remainingNames = ($remainingPackages | ForEach-Object { $_.PackageFullName }) -join ','
  throw "Operator.Runtime is still registered after uninstall timeout: $remainingNames"
}
[ordered]@{ removed = $packages.Count -gt 0; packageCount = $packages.Count } | ConvertTo-Json -Compress
`);
  return JSON.parse(out);
}

export async function removeOperatorForCi() {
  return await uninstallOperatorPackage();
}
