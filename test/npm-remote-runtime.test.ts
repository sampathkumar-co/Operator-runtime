import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  assertSupportedRuntime,
  assertSerializableAuthorizedRoot,
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
  assert.equal(assertSerializableAuthorizedRoot('C:\\work\\repo'), 'C:\\work\\repo');
  assert.throws(
    () => assertSerializableAuthorizedRoot('C:\\projects;\\repo'),
    /cannot contain the Windows path-list delimiter/
  );
});

test('remote launcher binds its local agent to an ephemeral loopback port', async () => {
  const source = await fs.readFile(path.resolve('packages/mecrod-operator/src/cli.mjs'), 'utf8');
  assert.match(source, /env\.OPERATOR_AGENT_HOST = '127\.0\.0\.1'/);
  assert.match(source, /env\.OPERATOR_AGENT_PORT = '0'/);
  assert.doesNotMatch(source, /env\.OPERATOR_AGENT_PORT = '47100'/);
});

test('npm runtime CI emits push evidence for every branch SHA', async () => {
  const workflow = await fs.readFile(path.resolve('.github/workflows/npm-remote-ci.yml'), 'utf8');
  const pushStart = workflow.indexOf('  push:');
  const pullRequestStart = workflow.indexOf('  pull_request:');
  assert.ok(pushStart >= 0 && pullRequestStart > pushStart);
  const pushSection = workflow.slice(pushStart, pullRequestStart);
  assert.match(pushSection, /branches:\s*\['\*\*'\]/);
  assert.equal(pushSection.includes('\n    paths:'), false);
  assert.equal(workflow.slice(pullRequestStart).includes('\n    paths:'), true);
});

test('runtime launcher allows only supported Windows x64 Node lines', () => {
  assert.doesNotThrow(() => assertSupportedRuntime('win32', 'x64', '22.14.0'));
  assert.doesNotThrow(() => assertSupportedRuntime('win32', 'x64', '22.23.2'));
  assert.doesNotThrow(() => assertSupportedRuntime('win32', 'x64', '24.21.0'));
  assert.doesNotThrow(() => assertSupportedRuntime('win32', 'x64', '26.8.2'));
  assert.throws(() => assertSupportedRuntime('linux', 'x64', '24.21.0'), /Windows x64/);
  assert.throws(() => assertSupportedRuntime('win32', 'arm64', '24.21.0'), /Windows x64/);
  for (const unsupported of ['22.13.1', '23.11.1', '25.8.1', '27.0.0']) {
    assert.throws(() => assertSupportedRuntime('win32', 'x64', unsupported), /Node\.js 22\.14\+, 24\.x, or 26\.x/);
  }
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
    OPERATOR_RELAY_URL: 'wss://evil.example/device',
    XDG_CONFIG_HOME: 'C:\\attacker\\config',
    XDG_DATA_HOME: 'C:\\attacker\\data',
    XDG_RUNTIME_DIR: 'C:\\attacker\\runtime'
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
  assert.equal(env.XDG_CONFIG_HOME, undefined);
  assert.equal(env.XDG_DATA_HOME, undefined);
  assert.equal(env.XDG_RUNTIME_DIR, undefined);
});

test('relay-only entrypoint derives executable roots independently of npm environment', async () => {
  const source = await fs.readFile(path.resolve('apps/local-agent/src/remote.ts'), 'utf8');
  const rootsCall = source.indexOf('const roots = trustedWindowsRoots(');
  const clearPath = source.indexOf("'PATH', 'Path', 'SYSTEMROOT', 'WINDIR', 'PROGRAMFILES'");
  const setTrusted = source.indexOf('process.env.SYSTEMROOT = roots.WINDOWS;');
  const loadMain = source.indexOf("await import('./main.ts')");
  assert.ok(rootsCall >= 0 && clearPath > rootsCall && setTrusted > clearPath && loadMain > setTrusted);
  assert.match(source, /\['system-roots'\]/);
  assert.match(source, /env:\s*\{\}/);
  assert.match(source, /OPERATOR_RELAY_REQUIRED = '1'/);
  assert.match(source, /OPERATOR_ALLOWED_ROOTS\.includes\(path\.win32\.delimiter\)/);
  assert.match(source, /wss:\/\/operator\.splcart\.in\/device/);
  assert.match(source, /https:\/\/operator\.splcart\.in\/v1\/device-result/);
  assert.doesNotMatch(source, /process\.env\.(?:SYSTEMROOT|WINDIR|PROGRAMFILES)\s*\|\|/);
  assert.doesNotMatch(source, /process\.env\.OPERATOR_RELAY_URL\s*\?\?/);
});

test('relay-only main treats terminal relay loss and emergency stop as fatal', async () => {
  const source = await fs.readFile(path.resolve('apps/local-agent/src/main.ts'), 'utf8');
  assert.match(source, /process\.env\.OPERATOR_RELAY_REQUIRED === '1'/);
  assert.match(source, /RELAY_REQUIRED_STOPPED/);
  assert.match(source, /RELAY_REQUIRED_EMERGENCY_STOP/);
  assert.match(source, /await failRequiredRelay\(error\)/);
});

test('npm publication fails closed unless exact source commit is supplied', async () => {
  const source = await fs.readFile(path.resolve('packages/mecrod-operator/src/publish-check.mjs'), 'utf8');
  assert.match(source, /process\.env\.OPERATOR_SOURCE_COMMIT/);
  assert.doesNotMatch(source, /process\.env\.GITHUB_SHA/);
  assert.match(source, /Refusing npm publish: OPERATOR_SOURCE_COMMIT/);
  assert.match(source, /manifest\.sourceCommit !== expectedCommit/);
});

test('npm release revalidates source binding outside suppressible lifecycle hooks', async () => {
  const workflow = await fs.readFile(path.resolve('.github/workflows/npm-remote-release.yml'), 'utf8');
  const directGate = workflow.indexOf('Revalidate exact source binding immediately before publish');
  const directCommand = workflow.indexOf('node packages/mecrod-operator/src/publish-check.mjs', directGate);
  const ignoreScripts = workflow.indexOf("NPM_CONFIG_IGNORE_SCRIPTS: 'false'", directCommand);
  const publish = workflow.indexOf('npm publish ./packages/mecrod-operator', directCommand);
  assert.ok(directGate >= 0 && directCommand > directGate && ignoreScripts > directCommand && publish > ignoreScripts);
  assert.match(workflow.slice(publish), /--ignore-scripts=false/);
});

test('runtime payload builder copies only tracked clean sources bound to HEAD', async () => {
  const source = await fs.readFile(path.resolve('packages/mecrod-operator/scripts/build-runtime-payload.mjs'), 'utf8');
  assert.match(source, /gitText\(\['status', '--porcelain=v1', '--untracked-files=no'/);
  assert.match(source, /\['ls-files', '-z', '--', repoRelativeRoot\]/);
  assert.match(source, /supplied\.toLowerCase\(\) !== head/);
  assert.match(source, /contains tracked changes/);
  assert.match(source, /copyTrackedTree\('src'/);
  assert.match(source, /copyTrackedTree\('apps\/local-agent\/src'/);
  assert.doesNotMatch(source, /copyTree\(path\.join\(repoRoot/);
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
