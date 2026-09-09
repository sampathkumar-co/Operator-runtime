import assert from 'node:assert/strict';
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

test('external writes require approval', () => {
  const policy = new PolicyEngine();
  assert.throws(() => policy.authorize({
    id: 'publish-1', capability: 'terminal.execute', risk: 'external', input: { cwd: '/tmp/operator-safe' }, provenance: { kind: 'chatgpt' }
  }, permissions), /explicit approval/);
});
