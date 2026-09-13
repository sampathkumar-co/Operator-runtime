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
  const runtime = createRuntime({ allowedRoots: [root], allowedExecutables: ['node'] });
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

  const approved = await fetch(`${base}/v1/approvals/${encodeURIComponent(action.id)}`, {
    method: 'POST',
    headers: { ...auth, 'x-operator-recovery-token': recoveryToken },
    body: JSON.stringify({ decision: 'approve' })
  });
  assert.equal(approved.status, 200);
  assert.equal((await approved.json() as any).approval.status, 'approved');

  const second = await fetch(`${base}/v1/execute`, {
    method: 'POST', headers: auth, body: JSON.stringify({ action })
  });
  assert.equal(second.status, 200);
  assert.equal((await second.json() as any).ok, true);
  assert.equal(await fs.readFile(filePath, 'utf8'), 'v2');

  const third = await fetch(`${base}/v1/execute`, {
    method: 'POST', headers: auth, body: JSON.stringify({ action })
  });
  assert.equal(third.status, 409);
  assert.equal((await third.json() as any).error.code, 'APPROVAL_REQUIRED');
  assert.equal(await fs.readFile(filePath, 'utf8'), 'v2');
});
