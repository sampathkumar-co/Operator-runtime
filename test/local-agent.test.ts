import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EmergencyStopStore } from '../apps/local-agent/src/emergency-stop.ts';
import { createRuntime } from '../apps/local-agent/src/runtime-factory.ts';
import { createLocalAgentServer } from '../apps/local-agent/src/server.ts';

test('local agent requires bearer token and returns structured evidence', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-agent-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const token = 'a'.repeat(64);
  const runtime = createRuntime({ allowedRoots: [root], allowedExecutables: ['node'] });
  const agent = createLocalAgentServer({
    runtime,
    token,
    permissions: { allowedCapabilities: ['computer.inspect', 'file.*'], allowedRoots: [root] }
  });
  t.after(() => agent.close());
  const bound = await agent.listen('127.0.0.1', 0);
  const url = `http://127.0.0.1:${bound.port}/v1/execute`;

  const denied = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(denied.status, 401);

  const allowed = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ action: { id: 'inspect-1', capability: 'computer.inspect', risk: 'read', input: {}, provenance: { kind: 'chatgpt' } } })
  });
  assert.equal(allowed.status, 200);
  const body = await allowed.json() as { ok: boolean; evidence: unknown[] };
  assert.equal(body.ok, true);
  assert.ok(body.evidence.length >= 1);
});

test('emergency stop blocks all execution, survives server restart, and requires separate recovery token to clear', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-agent-stop-root-'));
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-agent-stop-state-'));
  t.after(() => Promise.all([
    fs.rm(root, { recursive: true, force: true }),
    fs.rm(state, { recursive: true, force: true })
  ]));
  const token = 'a'.repeat(64);
  const recoveryToken = 'r'.repeat(64);
  const permissions = { allowedCapabilities: ['computer.inspect', 'file.*'], allowedRoots: [root] };

  const runtime1 = createRuntime({ allowedRoots: [root], allowedExecutables: ['node'] });
  const agent1 = createLocalAgentServer({
    runtime: runtime1,
    token,
    recoveryToken,
    emergencyStop: new EmergencyStopStore(state),
    permissions
  });
  const first = await agent1.listen('127.0.0.1', 0);
  const base1 = `http://127.0.0.1:${first.port}`;
  const auth = { authorization: `Bearer ${token}` };

  const engaged = await fetch(`${base1}/v1/emergency-stop`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ reason: 'user pressed emergency disconnect' })
  });
  assert.equal(engaged.status, 200);
  const engagedBody = await engaged.json() as any;
  assert.equal(engagedBody.state.engaged, true);
  assert.equal(engagedBody.state.reason, 'user pressed emergency disconnect');

  const blocked = await fetch(`${base1}/v1/execute`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ action: { id: 'blocked-1', capability: 'computer.inspect', risk: 'read', input: {}, provenance: { kind: 'chatgpt' } } })
  });
  assert.equal(blocked.status, 423);
  assert.equal((await blocked.json() as any).error.code, 'EMERGENCY_STOPPED');

  const wrongClear = await fetch(`${base1}/v1/emergency-stop`, {
    method: 'DELETE',
    headers: { ...auth, 'x-operator-recovery-token': token }
  });
  assert.equal(wrongClear.status, 401);
  assert.equal((await wrongClear.json() as any).error.code, 'RECOVERY_UNAUTHORIZED');

  await agent1.close();
  await runtime1.close();

  const runtime2 = createRuntime({ allowedRoots: [root], allowedExecutables: ['node'] });
  const agent2 = createLocalAgentServer({
    runtime: runtime2,
    token,
    recoveryToken,
    emergencyStop: new EmergencyStopStore(state),
    permissions
  });
  t.after(() => Promise.allSettled([agent2.close(), runtime2.close()]));
  const second = await agent2.listen('127.0.0.1', 0);
  const base2 = `http://127.0.0.1:${second.port}`;

  const health = await fetch(`${base2}/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json() as any).emergencyStopped, true);

  const stillBlocked = await fetch(`${base2}/v1/execute`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ action: { id: 'blocked-2', capability: 'computer.inspect', risk: 'read', input: {}, provenance: { kind: 'chatgpt' } } })
  });
  assert.equal(stillBlocked.status, 423);

  const cleared = await fetch(`${base2}/v1/emergency-stop`, {
    method: 'DELETE',
    headers: { ...auth, 'x-operator-recovery-token': recoveryToken }
  });
  assert.equal(cleared.status, 200);
  assert.equal((await cleared.json() as any).state.engaged, false);

  const resumed = await fetch(`${base2}/v1/execute`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ action: { id: 'resumed-1', capability: 'computer.inspect', risk: 'read', input: {}, provenance: { kind: 'chatgpt' } } })
  });
  assert.equal(resumed.status, 200);
  assert.equal((await resumed.json() as any).ok, true);
});
