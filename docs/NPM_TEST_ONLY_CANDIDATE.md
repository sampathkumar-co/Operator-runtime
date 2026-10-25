# Installing a Mecord Test-Only Candidate (Windows)

**This is not a production release.** The production npm package remains `mecord-connect@2.0.6`.
Do not use this procedure to recover or replay the original device's protected
`.operator` state. No source-only CI run certifies physical Chrome/Edge/UIA,
a real hosted relay or multi-host restoration.

## Create the exact-source test archive

Once the proposed workflow is reviewed and merged, open:
**GitHub → Operator-runtime → Actions → Mecord Isolated NPM Test Candidate → Run workflow**.
Select **main**, choose a unique `2.0.7-rc.N` candidate number, and run.
The workflow builds and self-tests native Windows helpers, creates a
source-pinned JavaScript runtime, packs it as a `.tgz`, installs it in a
disposable CI directory and runs `doctor`. It never publishes to npm.

Download the Actions artifact named
`mecord-test-only-2.0.7-rc.N-<exact-40-character-main-SHA>`.
It contains the npm `.tgz`, a `.tgz.sha256` checksum and
`test-candidate.json`. The manifest's `sourceCommit` must match the
workflow checkout SHA. If CI failed or the artifact hashes do not match,
stop; do not install the archive.

## Install side by side without overwriting stable 2.0.6

Extract the downloaded GitHub artifact into a trusted test directory. Open
PowerShell and set the actual extracted archive path, for example:

```powershell
$Archive = 'C:\\MecordTestArtifact\\mecord-connect-2.0.7-rc.1.tgz'
$TestRoot = Join-Path $env:USERPROFILE 'mecord-isolated-rc-test'
$ExpectedSha = (Get-Content "$Archive.sha256" -Raw).Trim().Split(' ')[0]
$ActualSha = (Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($ActualSha -ne $ExpectedSha) { throw 'Test candidate checksum mismatch' }
New-Item -ItemType Directory -Force -Path $TestRoot | Out-Null
npm install --prefix $TestRoot --ignore-scripts --no-audit --no-fund $Archive
if ($LASTEXITCODE -ne 0) { throw 'Isolated package installation failed' }
node (Join-Path $TestRoot 'node_modules/mecord-connect/bin/operator.mjs') doctor
if ($LASTEXITCODE -ne 0) { throw 'Installed candidate doctor failed' }
```

This deliberately does **not** run `npm install -g`, replace the global
launcher, start the relay or access protected receipts. Confirm the
`test-candidate.json` exact SHA and version before any authorized live
testing. Run only isolated, reversible tasks first; original-device and
cross-host physical acceptance require their own separate plan.

## What it proves

A successful Actions archive verifies source-bound packaging, Windows CI
native builds, isolated npm installation and the packaged doctor's checks.
It does **not** prove a new public npm version exists, integrated AI success,
live computer accuracy, source-matched hosted deployment, recovery of
quarantined receipts, or authorization to publish/stage npm.
