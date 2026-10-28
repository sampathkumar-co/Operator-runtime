import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { ProcessProvider } from '../src/capabilities/process.ts';

test('C06-11 explicit path-lease helper configuration reaches ProcessProvider Job Object execution', () => {
  const factory = fs.readFileSync('apps/local-agent/src/runtime-factory.ts', 'utf8');
  const processSource = fs.readFileSync('src/capabilities/process.ts', 'utf8');
  assert.match(factory, /new ProcessProvider\([\s\S]*windowsPathLeaseExecutable: config\.windowsPathLeasePath/);
  assert.match(processSource, /configuredWindowsHelper \?\? process\.env\.OPERATOR_WINDOWS_PATH_LEASE_PATH/);
  assert.match(processSource, /PROCESS_JOB_CONTAINMENT_REQUIRED/);
  assert.match(processSource, /\['job-run', cwd, trustedExecutable, \.\.\.args\]/);
});

test('C06-11 ProcessProvider rejects relative or NUL-bearing helper paths before execution', () => {
  const options = { allowedRoots: [process.cwd()], allowedExecutables: [] };
  for (const helper of ['relative-helper.exe', `C:${path.sep}helper\0.exe`]) {
    assert.throws(() => new ProcessProvider({ ...options, windowsPathLeaseExecutable: helper }),
      (error: any) => error?.code === 'PROCESS_JOB_HELPER_INVALID');
  }
});

test('C06-11 source packaging contains, launches and independently checks the same helper filename', () => {
  const build = fs.readFileSync('packaging/windows/build-release.ps1', 'utf8');
  const launcher = fs.readFileSync('native/windows-launcher/src/main.rs', 'utf8');
  const remote = fs.readFileSync('apps/local-agent/src/remote.ts', 'utf8');
  const workflow = fs.readFileSync('.github/workflows/ci.yml', 'utf8');
  for (const source of [build, launcher, remote, workflow]) assert.match(source, /operator-windows-path-lease\.exe/);
  assert.match(build, /windows-path-lease\\build\.ps1[\s\S]*-RequireDeterministic/);
  assert.match(build, /Copy-Item -LiteralPath \$pathLease/);
  assert.match(workflow, /Packaged path-lease helper self-test failed/);
});
