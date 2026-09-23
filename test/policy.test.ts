import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { PolicyEngine } from '../src/core/policy.ts';

const permissions = {
  allowedCapabilities: ['file.*', 'terminal.execute'],
  allowedRoots: ['/tmp/operator-safe'],
  allowExternalWrites: false,
  allowSystemChanges: false,
  allowDestructive: false
};

test('observed webpage content cannot become an instruction authority', () => {
  const policy = new PolicyEngine();
  assert.throws(() => policy.authorize({
    id: 'a1', capability: 'file.read', risk: 'read', input: { path: '/tmp/operator-safe/a.txt' }, provenance: { kind: 'website', source: 'https://evil.example' }
  }, permissions), /cannot redefine task goals or permissions/);
});

test('lexically out-of-scope path is denied before execution', () => {
  const policy = new PolicyEngine();
  assert.throws(() => policy.authorize({
    id: 'a2', capability: 'file.read', risk: 'read', input: { path: '/tmp/other/a.txt' }, provenance: { kind: 'chatgpt' }
  }, permissions), /outside the authorized roots/);
});

test('destructive actions require approval', () => {
  const policy = new PolicyEngine();
  assert.throws(() => policy.authorize({
    id: 'publish-1', capability: 'terminal.execute', risk: 'destructive', input: { cwd: '/tmp/operator-safe' }, provenance: { kind: 'chatgpt' }
  }, permissions), /explicit approval/);
});


test('relative project paths are authorized against the single root while traversal and ambiguous roots stay denied', () => {
  const policy = new PolicyEngine();
  const root = path.resolve('/tmp/operator-safe');
  const singleRoot = { ...permissions, allowedRoots: [root] };
  const forms = process.platform === 'win32'
    ? ['src/a.txt', './src/a.txt', '.\\src\\a.txt']
    : ['src/a.txt', './src/a.txt'];

  for (const inputPath of forms) {
    assert.doesNotThrow(() => policy.authorize({
      id: `relative-${inputPath}`,
      capability: 'file.read',
      risk: 'read',
      input: { path: inputPath },
      provenance: { kind: 'chatgpt' }
    }, singleRoot), inputPath);
  }

  assert.throws(() => policy.authorize({
    id: 'relative-traversal',
    capability: 'file.read',
    risk: 'read',
    input: { path: '../outside.txt' },
    provenance: { kind: 'chatgpt' }
  }, singleRoot), /outside the authorized roots/);

  assert.throws(() => policy.authorize({
    id: 'relative-ambiguous',
    capability: 'file.read',
    risk: 'read',
    input: { path: 'src/a.txt' },
    provenance: { kind: 'chatgpt' }
  }, { ...permissions, allowedRoots: [root, path.resolve('/tmp/operator-other')] }), /outside the authorized roots/);
});
