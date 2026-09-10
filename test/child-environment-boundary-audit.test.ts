import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { safeChildEnvironment } from '../src/core/child-environment.ts';

const poisoned: NodeJS.ProcessEnv = {
  PATH: '/safe/bin',
  DISPLAY: ':0',
  SYSTEMROOT: 'C:\\Windows',
  TEMP: 'C:\\Temp',
  OPENAI_API_KEY: 'secret-openai',
  AWS_SECRET_ACCESS_KEY: 'secret-aws',
  GITHUB_TOKEN: 'secret-github',
  OPERATOR_AGENT_TOKEN: 'secret-operator',
  NODE_OPTIONS: '--require=evil.js',
  ELECTRON_RUN_AS_NODE: '1'
};

test('child environment profiles preserve only required OS/session variables', () => {
  const desktop = safeChildEnvironment('desktop', poisoned);
  assert.equal(desktop.PATH, '/safe/bin');
  assert.equal(desktop.DISPLAY, ':0');
  assert.equal(desktop.SYSTEMROOT, 'C:\\Windows');
  const native = safeChildEnvironment('windows-native', poisoned);
  assert.equal(native.SYSTEMROOT, 'C:\\Windows');
  assert.equal(native.TEMP, 'C:\\Temp');
  assert.equal(native.PATH, undefined);
  for (const key of ['OPENAI_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN', 'OPERATOR_AGENT_TOKEN', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE']) {
    assert.equal(desktop[key], undefined, `${key} leaked to desktop child`);
    assert.equal(native[key], undefined, `${key} leaked to native child`);
  }
});

test('sensitive production spawns explicitly use scrubbed child environments', async () => {
  const root = path.resolve(import.meta.dirname, '..');
  const cases = [
    ['src/capabilities/browser-managed.ts', "env: safeChildEnvironment('desktop')"],
    ['src/capabilities/windows-uia.ts', "env: safeChildEnvironment('windows-native')"],
    ['src/core/device-identity.ts', "env: safeChildEnvironment('windows-native')"]
  ] as const;
  for (const [relative, expected] of cases) {
    const source = await fs.readFile(path.join(root, relative), 'utf8');
    assert.equal(source.includes(expected), true, `${relative} must scrub inherited environment`);
  }
});