import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

function text(relative: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), 'utf8');
}

test('Windows Store release contract pins Partner Center identity and certified Node runtime', () => {
  const build = text('packaging/windows/build-release.ps1');
  const ci = text('.github/workflows/ci.yml');
  const production = text('.github/workflows/windows-production-release.yml');
  assert.match(build, /\[string\]\$Version = '1\.0\.0\.0'/);
  assert.match(build, /CN=6F726FAE-9AD9-4643-A991-7E86CBD7C967/);
  assert.match(build, /SPLCART\.SplcartOperator/);
  assert.match(build, /<DisplayName>SPLCART Operator<\/DisplayName>/);
  assert.match(build, /<PublisherDisplayName>SPLCART<\/PublisherDisplayName>/);
  assert.match(build, /\$certifiedNodeVersion = 'v22\.23\.2'/);
  assert.match(build, /0d0f5e39f9f3d9587bc19f73eab3c2c9c4903fd02d6dbf9c853dd81b3d95fad4/);
  assert.match(ci, /build-release\.ps1 -Version 1\.0\.0\.0/);
  assert.match(ci, /splcart-operator-store-submission-msix/);
  assert.ok(ci.includes('SPLCART\\.SplcartOperator'));
  assert.ok(ci.includes('CN=6F726FAE-9AD9-4643-A991-7E86CBD7C967'));
  assert.ok(ci.includes('Store package version mismatch'));
  assert.match(production, /STORE_PUBLISHER: CN=6F726FAE-9AD9-4643-A991-7E86CBD7C967/);
  assert.match(production, /\$cert\.Subject -ne \$env:STORE_PUBLISHER/);
  assert.match(production, /-Publisher \$env:STORE_PUBLISHER/);
  assert.doesNotMatch(production, /-Publisher '\$\{\{ steps\.certificate\.outputs\.publisher \}\}'/);
  assert.match(production, /^name: Windows Direct Distribution Release/m);
});

test('Windows native release toolchain is pinned to Rust 1.98.1', () => {
  const build = text('packaging/windows/build-release.ps1');
  const workflows = [
    text('.github/workflows/ci.yml'),
    text('.github/workflows/platform-matrix.yml'),
    text('.github/workflows/windows-production-release.yml'),
    text('.github/workflows/windows-signing-smoke.yml')
  ];
  assert.match(build, /Release build requires certified rustc 1\.98\.1/);
  for (const workflow of workflows) {
    assert.doesNotMatch(workflow, /rustup default 1\.98\.0/);
    assert.match(workflow, /rustup default 1\.98\.1/);
  }
});


test('local Store audit prebuilt native mode is explicit, hash-bound, and forbidden in CI', () => {
  const build = text('packaging/windows/build-release.ps1');
  assert.match(build, /\[string\]\$AuditPrebuiltNativeDir = ''/);
  assert.match(build, /AuditPrebuiltNativeDir is local-audit-only and must not be used in CI/);
  assert.match(build, /All audit native SHA-256 values are required and must be 64 hex characters/);
  assert.match(build, /Get-FileHash -LiteralPath \$entry\[0\] -Algorithm SHA256/);
  assert.match(build, /if \(\$env:CI\)/);
});

test('Windows packaging resolves relative output under repo and runs npm with certified Node', () => {
  const build = text('packaging/windows/build-release.ps1');
  assert.match(build, /IsPathRooted\(\$OutputDir\)/);
  assert.match(build, /Join-Path \$repo \$OutputDir/);
  assert.match(build, /node_modules\\npm\\bin\\npm-cli\.js/);
  assert.match(build, /& \$NodeExe \$npmCli ci --ignore-scripts --omit=dev --prefix \$mcpDeps/);
  assert.doesNotMatch(build, /& npm\.cmd ci --ignore-scripts --omit=dev --prefix \$mcpDeps/);
});


test('Windows package prunes non-runtime dependency test and benchmark directories', () => {
  const build = text('packaging/windows/build-release.ps1');
  assert.match(build, /\$nonRuntimeDependencyDirs = @\('test', 'tests', 'fixtures', 'benchmark', 'benchmarks', '\.github'\)/);
  assert.match(build, /Get-ChildItem -LiteralPath \$dependencyRoot -Directory -Recurse -Force/);
  assert.match(build, /Remove-Item -LiteralPath \$_\.FullName -Recurse -Force/);
});
