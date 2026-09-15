import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ApprovalStore } from '../apps/local-agent/src/approval-store.ts';
import { createRuntime } from '../apps/local-agent/src/runtime-factory.ts';
import { createLocalAgentServer } from '../apps/local-agent/src/server.ts';

async function temp(t: test.TestContext, prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('one-time approval binds exact action, resumes once, and cannot be replayed', async (t) => {
  const root = await temp(t, 'operator-approval-root-');
  const state = await temp(t, 'operator-approval-state-');
  const filePath = path.join(root, 'approved.txt');
  await fs.writeFile(filePath, 'v1');
  const expectedSha256 = crypto.createHash('sha256').update('v1').digest('hex');
  const token = 'a'.repeat(64);
  const recoveryToken = 'r'.repeat(64);
  const runtime = createRuntime({
    allowedRoots: [root],
    allowedExecutables: ['node'],
    windowsPathLeasePath: process.platform === 'win32'
      ? path.resolve('native/windows-path-lease/target/release/operator-windows-path-lease.exe')
      : undefined
  });
  const approvals = new ApprovalStore(state);
  const agent = createLocalAgentServer({
    runtime,
    token,
    recoveryToken,
    approvals,
    permissions: {
      allowedCapabilities: ['file.*'],
      allowedRoots: [root],
      allowDestructive: false
    }
  });
  t.after(() => Promise.allSettled([agent.close(), runtime.close()]));
  const bound = await agent.listen('127.0.0.1', 0);
  const base = `http://127.0.0.1:${bound.port}`;
  const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const action = {
    id: 'approval-safe-replace',
    capability: 'file.replace',
    risk: 'destructive',
    input: { path: filePath, content: 'v2', expectedSha256 },
    provenance: { kind: 'chatgpt' }
  };

  const first = await fetch(`${base}/v1/execute`, {
    method: 'POST', headers: auth, body: JSON.stringify({ action })
  });
  assert.equal(first.status, 409);
  assert.equal((await first.json() as any).error.code, 'APPROVAL_REQUIRED');
  assert.equal(await fs.readFile(filePath, 'utf8'), 'v1');

  const pending = await fetch(`${base}/v1/approvals`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(pending.status, 200);
  const pendingBody = await pending.json() as any;
  assert.equal(pendingBody.approvals[0].actionId, action.id);
  assert.equal(pendingBody.approvals[0].status, 'pending');
  assert.match(pendingBody.approvals[0].approvalRequestId, /^[0-9a-f-]{36}$/i);
  const approvalRequestId = pendingBody.approvals[0].approvalRequestId;

  const approved = await fetch(`${base}/v1/approvals/${encodeURIComponent(action.id)}`, {
    method: 'POST',
    headers: { ...auth, 'x-operator-recovery-token': recoveryToken },
    body: JSON.stringify({ decision: 'approve', approvalRequestId })
  });
  assert.equal(approved.status, 200);
  assert.equal((await approved.json() as any).approval.status, 'approved');

  const second = await fetch(`${base}/v1/execute`, {
    method: 'POST', headers: auth, body: JSON.stringify({ action })
  });
  const secondBody = await second.json() as any;
  assert.equal(second.status, 200, JSON.stringify(secondBody));
  assert.equal(secondBody.ok, true);
  assert.equal(await fs.readFile(filePath, 'utf8'), 'v2');

  const third = await fetch(`${base}/v1/execute`, {
    method: 'POST', headers: auth, body: JSON.stringify({ action })
  });
  assert.equal(third.status, 409);
  assert.equal((await third.json() as any).error.code, 'APPROVAL_REQUIRED');
  assert.equal(await fs.readFile(filePath, 'utf8'), 'v2');
});

test('pending approval expires hard and is physically pruned', async (t) => {
  const state = await temp(t, 'operator-approval-expiry-');
  let now = Date.parse('2026-09-14T00:00:00.000Z');
  const store = new ApprovalStore(state, { clock: () => new Date(now) });
  const action = {
    id: 'pending-expiry', capability: 'file.replace', risk: 'destructive' as const,
    input: { path: 'C:\\repo\\a.txt', content: 'v2', expectedSha256: 'a'.repeat(64) },
    provenance: { kind: 'chatgpt' as const }
  };
  const pending = await store.register(action);
  now += 10 * 60_000 + 1;
  await assert.rejects(
    store.approve(action.id, pending.approvalRequestId),
    (error: any) => error?.code === 'APPROVAL_EXPIRED'
  );
  const persisted = JSON.parse(await fs.readFile(path.join(state, 'approvals.json'), 'utf8'));
  assert.deepEqual(persisted.records, []);
});

test('approval authority cannot cross accounts or survive A-B-A rebinding generation', async (t) => {
  const state = await temp(t, 'operator-approval-authority-');
  const store = new ApprovalStore(state);
  const action = {
    id: 'authority-bound', capability: 'file.replace', risk: 'destructive' as const,
    input: { path: 'C:\\repo\\a.txt', content: 'v2', expectedSha256: 'b'.repeat(64) },
    provenance: { kind: 'chatgpt' as const }
  };
  const deviceId = '11111111-1111-4111-8111-111111111111';
  const accountA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const accountB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const a1 = { accountId: accountA, deviceId, generation: 1 };
  const b2 = { accountId: accountB, deviceId, generation: 2 };
  const a3 = { accountId: accountA, deviceId, generation: 3 };

  const pending = await store.register(action, a1);
  await store.approve(action.id, pending.approvalRequestId);
  assert.equal(await store.isApproved(action, a1), true);
  assert.equal(await store.isApproved(action, b2), false);
  assert.equal(await store.isApproved(action, a3), false);
});

test('authority replacement rotates approval request identity and stale nonce cannot approve', async (t) => {
  const state = await temp(t, 'operator-approval-request-id-');
  const store = new ApprovalStore(state);
  const action = {
    id: 'nonce-rotation', capability: 'file.replace', risk: 'destructive' as const,
    input: { path: 'C:\\repo\\b.txt', content: 'v2', expectedSha256: 'c'.repeat(64) },
    provenance: { kind: 'chatgpt' as const }
  };
  const first = await store.register(action, {
    accountId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    deviceId: '11111111-1111-4111-8111-111111111111', generation: 1
  });
  const second = await store.register(action, {
    accountId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    deviceId: '11111111-1111-4111-8111-111111111111', generation: 2
  });
  assert.notEqual(first.approvalRequestId, second.approvalRequestId);
  await assert.rejects(store.approve(action.id, first.approvalRequestId), (error: any) => error?.code === 'APPROVAL_REQUEST_MISMATCH');
  const approved = await store.approve(action.id, second.approvalRequestId);
  assert.equal(approved.status, 'approved');
});

test('approval authority survives restart only for the same bound generation', async (t) => {
  const state = await temp(t, 'operator-approval-restart-');
  const action = {
    id: 'restart-bound', capability: 'file.replace', risk: 'destructive' as const,
    input: { path: 'C:\\repo\\c.txt', content: 'v2', expectedSha256: 'd'.repeat(64) },
    provenance: { kind: 'chatgpt' as const }
  };
  const authority = {
    accountId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    deviceId: '11111111-1111-4111-8111-111111111111', generation: 7
  };
  const firstStore = new ApprovalStore(state);
  const pending = await firstStore.register(action, authority);
  await firstStore.approve(action.id, pending.approvalRequestId);

  const restarted = new ApprovalStore(state);
  assert.equal(await restarted.isApproved(action, authority), true);
  assert.equal(await restarted.isApproved(action, { ...authority, generation: 8 }), false);
});

test('legacy v1 approvals fail closed and migrate to empty v2 authority state', async (t) => {
  const state = await temp(t, 'operator-approval-legacy-');
  await fs.writeFile(path.join(state, 'approvals.json'), JSON.stringify({
    version: 1,
    records: [{ actionId: 'legacy', actionHash: 'e'.repeat(64), status: 'approved' }]
  }));
  const store = new ApprovalStore(state);
  assert.deepEqual(await store.list(), []);
  const persisted = JSON.parse(await fs.readFile(path.join(state, 'approvals.json'), 'utf8'));
  assert.equal(persisted.version, 2);
  assert.deepEqual(persisted.records, []);
});
