import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OperatorRuntime } from '../src/core/runtime.ts';
import { FilesystemProvider } from '../src/capabilities/filesystem.ts';
import type { ActionRequest, ActionRisk, PermissionProfile } from '../src/core/types.ts';

const sha256 = (data: string) => crypto.createHash('sha256').update(data).digest('hex');

const laneTest = process.platform === 'win32' && !process.env.OPERATOR_WINDOWS_PATH_LEASE_PATH ? test.skip : test;

async function fixture(t: test.TestContext) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-lane-b-fixed-trace-'));
  const root = path.join(base, 'authorized');
  const outside = path.join(base, 'outside');
  await fs.mkdir(root);
  await fs.mkdir(outside);
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const runtime = new OperatorRuntime().register(new FilesystemProvider({
    allowedRoots: [root], windowsPathLeaseExecutable: process.env.OPERATOR_WINDOWS_PATH_LEASE_PATH
  }));
  const permission: PermissionProfile = {
    allowedRoots: [root], allowedCapabilities: ['file.create', 'file.read', 'file.replace'],
    maxRisk: 'destructive', approvedActionIds: ['lane-b-approved-replace']
  };
  const action = (id: string, capability: string, risk: ActionRisk, input: Record<string, unknown>): ActionRequest => ({
    id, capability, risk, input, provenance: { kind: 'user' }
  });
  return { base, root, outside, runtime, permission, action };
}

laneTest('C01 Lane B fixed-action create/read/replace is verified against independent filesystem state', async t => {
  const { root, runtime, permission, action } = await fixture(t);
  const target = path.join(root, 'synthetic.txt');
  const firstBytes = 'model-neutral fixture version 1\n';
  const finalBytes = 'model-neutral fixture version 2\n';
  const create = await runtime.execute(action('lane-b-create', 'file.create', 'write', { path: target, content: firstBytes }), permission);
  assert.equal(create.ok, true, create.error?.message);
  assert.equal(await fs.readFile(target, 'utf8'), firstBytes);
  assert.equal(sha256(await fs.readFile(target, 'utf8')), sha256(firstBytes));
  const read = await runtime.execute(action('lane-b-read', 'file.read', 'read', { path: target }), permission);
  assert.equal(read.ok, true, read.error?.message);
  assert.equal((read.output as any).sha256, sha256(firstBytes));
  const replace = await runtime.execute(action('lane-b-approved-replace', 'file.replace', 'destructive', {
    path: target, content: finalBytes, expectedSha256: (read.output as any).sha256
  }), permission);
  assert.equal(replace.ok, true, replace.error?.message);
  // Independent verifier reads the real fixture, not the tool's success text.
  const actual = await fs.readFile(target, 'utf8');
  assert.equal(actual, finalBytes);
  assert.equal(sha256(actual), sha256(finalBytes));
});

laneTest('C01 Lane B stale expected hash fails closed and cannot change destination bytes', async t => {
  const { root, runtime, permission, action } = await fixture(t);
  const target = path.join(root, 'stale.txt');
  await fs.writeFile(target, 'fresh-on-disk');
  const result = await runtime.execute(action('lane-b-approved-replace', 'file.replace', 'destructive', {
    path: target, content: 'not-allowed', expectedSha256: sha256('stale-on-client')
  }), permission);
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'PRECONDITION_FAILED');
  assert.equal(await fs.readFile(target, 'utf8'), 'fresh-on-disk');
});

laneTest('C01 Lane B out-of-scope write is denied before any outside file changes', async t => {
  const { outside, runtime, permission, action } = await fixture(t);
  const target = path.join(outside, 'forbidden.txt');
  const result = await runtime.execute(action('lane-b-outside', 'file.create', 'write', {
    path: target, content: 'should-not-exist'
  }), permission);
  assert.equal(result.ok, false);
  assert.equal(result.provider, 'policy');
  assert.equal(result.error?.code, 'PATH_OUTSIDE_SCOPE');
  await assert.rejects(() => fs.access(target));
});

laneTest('C01 Lane B missing explicit destructive approval cannot mutate an existing file', async t => {
  const { root, runtime, permission, action } = await fixture(t);
  const target = path.join(root, 'approval.txt');
  await fs.writeFile(target, 'original');
  const result = await runtime.execute(action('lane-b-unapproved-replace', 'file.replace', 'destructive', {
    path: target, content: 'tampered', expectedSha256: sha256('original')
  }), permission);
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'APPROVAL_REQUIRED');
  assert.equal(await fs.readFile(target, 'utf8'), 'original');
});
