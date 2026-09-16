import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  assertSupportedRuntime,
  parseArgs,
  safeRuntimeEnvironment,
  validateRuntimeManifest
} from '../packages/mecrod-operator/src/cli.mjs';

function manifest(overrides: Record<string, unknown> = {}) {
  const required = [
    'app/apps/local-agent/src/remote.ts',
    'native/operator-windows-dpapi.exe',
    'native/operator-windows-uia.exe',
    'native/operator-windows-path-lease.exe'
  ];
  return {
    schemaVersion: 1,
    package: '@mecrod/operator',
    version: '1.0.0',
    platform: 'win32',
    arch: 'x64',
    sourceCommit: 'a'.repeat(40),
    files: required.map((path) => ({ path, sizeBytes: 1, sha256: 'b'.repeat(64) })),
    ...overrides
  };
}

test('remote CLI is explicit and bounded', () => {
  assert.deepEqual(parseArgs(['remote']), { command: 'remote', root: process.cwd(), browser: true });
  assert.deepEqual(parseArgs(['remote', '--root', 'C:\\work', '--no-browser']), {
    command: 'remote', root: 'C:\\work', browser: false
  });
  assert.deepEqual(parseArgs(['doctor']), { command: 'doctor' });
  assert.throws(() => parseArgs(['remote', '--relay', 'wss://evil.example/device']), /Unknown remote option/);
  assert.throws(() => parseArgs(['doctor', '--root', '.']), /does not accept arguments/);
});

test('runtime launcher allows only the certified Node 22 Windows x64 line', () => {
  assert.doesNotThrow(() => assertSupportedRuntime('win32', 'x64', '22.14.0'));
  assert.doesNotThrow(() => assertSupportedRuntime('win32', 'x64', '22.23.2'));
  assert.throws(() => assertSupportedRuntime('linux', 'x64', '22.23.2'), /Windows x64/);
  assert.throws(() => assertSupportedRuntime('win32', 'arm64', '22.23.2'), /Windows x64/);
  assert.throws(() => assertSupportedRuntime('win32', 'x64', '23.0.0'), /Node\.js 22\.14 through 22\.x/);
});

test('npx parent credentials are not inherited by the remote runtime', () => {
  const env = safeRuntimeEnvironment({
    Path: 'C:\\project\\node_modules\\.bin;C:\\Windows\\System32',
    USERPROFILE: 'C:\\Users\\test',
    TEMP: 'C:\\Temp',
    NPM_TOKEN: 'npm-secret',
    NODE_AUTH_TOKEN: 'node-secret',
    GITHUB_TOKEN: 'github-secret',
    AWS_SECRET_ACCESS_KEY: 'aws-secret',
    NPM_CONFIG_USERCONFIG: 'C:\\Users\\test\\.npmrc',
    NODE_OPTIONS: '--require malicious.js',
    OPERATOR_RELAY_URL: 'wss://evil.example/device'
  });
  assert.equal(env.USERPROFILE, 'C:\\Users\\test');
  assert.equal(env.TEMP, 'C:\\Temp');
  assert.equal(env.NPM_TOKEN, undefined);
  assert.equal(env.NODE_AUTH_TOKEN, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(env.NPM_CONFIG_USERCONFIG, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.OPERATOR_RELAY_URL, undefined);
});

test('relay-only entrypoint removes npm PATH authority before importing providers', async () => {
  const source = await fs.readFile(path.resolve('apps/local-agent/src/remote.ts'), 'utf8');
  const deleteUpper = source.indexOf('delete process.env.PATH;');
  const deleteMixed = source.indexOf('delete process.env.Path;');
  const setTrusted = source.indexOf('process.env.Path =');
  const loadMain = source.indexOf("await import('./main.ts')");
  assert.ok(deleteUpper >= 0 && deleteMixed > deleteUpper && setTrusted > deleteMixed && loadMain > setTrusted);
  assert.match(source, /wss:\/\/operator\.splcart\.in\/device/);
  assert.match(source, /https:\/\/operator\.splcart\.in\/v1\/device-result/);
  assert.doesNotMatch(source, /process\.env\.OPERATOR_RELAY_URL\s*\?\?/);
});

test('npm publication fails closed unless exact source commit is supplied', async () => {
  const source = await fs.readFile(path.resolve('packages/mecrod-operator/src/publish-check.mjs'), 'utf8');
  assert.match(source, /process\.env\.OPERATOR_SOURCE_COMMIT/);
  assert.doesNotMatch(source, /process\.env\.GITHUB_SHA/);
  assert.match(source, /Refusing npm publish: OPERATOR_SOURCE_COMMIT/);
  assert.match(source, /manifest\.sourceCommit !== expectedCommit/);
});

test('runtime manifest requires the complete hardened native boundary', () => {
  const parsed = validateRuntimeManifest(manifest());
  assert.equal(parsed.files.length, 4);
  assert.throws(() => validateRuntimeManifest(manifest({ files: (manifest().files as any[]).slice(0, 3) })), /file list|missing/);
  assert.throws(() => validateRuntimeManifest(manifest({ sourceCommit: 'bad' })), /source commit/);
  assert.throws(() => validateRuntimeManifest(manifest({
    files: [
      ...(manifest().files as any[]).slice(0, 3),
      { path: '../operator-windows-path-lease.exe', sizeBytes: 1, sha256: 'b'.repeat(64) }
    ]
  })), /unsafe file path|missing/);
});
