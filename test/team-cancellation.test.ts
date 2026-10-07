import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TeamCoordinator } from '../src/core/team-coordinator.ts';
import { createRuntime } from '../apps/local-agent/src/runtime-factory.ts';
import { createLocalAgentServer } from '../apps/local-agent/src/server.ts';

function workspaceResource(root: string): string {
  const normalized = path.resolve(root).replace(/\\/g, '/');
  return 'workspace:' + (process.platform === 'win32' ? normalized.toLowerCase() : normalized);
}

test('stage4 pause aborts in-flight mutating worker execution and marks its resource uncertain', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-team-cancel-root-'));
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-team-cancel-state-'));
  t.after(() => Promise.all([
    fs.rm(root, { recursive: true, force: true }),
    fs.rm(state, { recursive: true, force: true })
  ]));

  const teams = new TeamCoordinator(state);
  const runtime = createRuntime({
    allowedRoots: [root],
    allowedExecutables: ['node'],
    terminalAllowedExecutables: ['node']
  });
  const token = 'q'.repeat(64);
  const agent = createLocalAgentServer({
    runtime,
    token,
    teams,
    permissions: {
      allowedCapabilities: ['terminal.execute'],
      allowedRoots: [root],
      allowDestructive: true,
      allowSystemChanges: false,
      allowExternalWrites: false
    }
  });
  t.after(() => Promise.allSettled([agent.close(), runtime.close()]));
  const bound = await agent.listen('127.0.0.1', 0);
  const base = 'http://127.0.0.1:' + bound.port;
  const headers = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };
  const resource = workspaceResource(root);

  const submit = await fetch(base + '/v1/teams', {
    method: 'POST', headers,
    body: JSON.stringify({
      objective: 'Run cancellable worker process',
      run: true,
      workItems: [
        { key: 'long', title: 'Long process', role: 'coder', risk: 'destructive', resources: [resource], allowedCapabilities: ['terminal.execute'] },
        { key: 'verify', title: 'Verify', role: 'verifier', dependsOn: ['long'] }
      ]
    })
  });
  assert.equal(submit.status, 200);
  const missionId = (await submit.json() as any).mission.id as string;

  const register = await fetch(base + '/v1/teams/' + missionId + '/workers/register', {
    method: 'POST', headers,
    body: JSON.stringify({ role: 'coder', label: 'coder', capabilities: ['terminal.execute'] })
  });
  assert.equal(register.status, 200);
  const workerId = (await register.json() as any).worker.id as string;

  const claimResponse = await fetch(base + '/v1/teams/' + missionId + '/claim', {
    method: 'POST', headers, body: JSON.stringify({ workerId })
  });
  assert.equal(claimResponse.status, 200);
  const claim = await claimResponse.json() as any;
  assert.equal(claim.workItem.key, 'long');

  const executePromise = fetch(base + '/v1/teams/' + missionId + '/work/' + claim.workItem.id + '/execute', {
    method: 'POST', headers,
    body: JSON.stringify({
      workerId,
      leaseId: claim.workItem.lease.id,
      action: {
        id: crypto.randomUUID(),
        capability: 'terminal.execute',
        risk: 'destructive',
        input: {
          executable: 'node',
          args: ['-e', 'setInterval(()=>{},1000)'],
          cwd: root,
          timeoutMs: 600000
        },
        provenance: { kind: 'chatgpt' }
      }
    })
  });

  const dispatchDeadline = Date.now() + 5_000;
  while (true) {
    const inFlight = await fetch(base + '/v1/teams/' + missionId, {
      headers: { authorization: 'Bearer ' + token }
    });
    assert.equal(inFlight.status, 200);
    const snapshot = (await inFlight.json() as any).mission;
    if (snapshot.actionReceipts.some((receipt: any) => receipt.actionId && receipt.state === 'DISPATCHING')) break;
    assert.ok(Date.now() < dispatchDeadline, 'worker action did not reach durable DISPATCHING state before pause');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  const pause = await fetch(base + '/v1/teams/' + missionId + '/pause', {
    method: 'POST', headers, body: '{}'
  });
  assert.equal(pause.status, 200);
  const pausedMission = (await pause.json() as any).mission;
  assert.equal(pausedMission.state, 'PAUSED');
  assert.equal(pausedMission.workItems.find((item: any) => item.key === 'long').state, 'NEEDS_RECONCILIATION');
  assert.equal(pausedMission.resources.find((item: any) => item.key === resource).uncertain, true);

  const execution = await executePromise;
  assert.equal(execution.status, 409);
  const executionBody = await execution.json() as any;
  assert.equal(executionBody.error.code, 'EXECUTION_ABORTED');

  const inspect = await fetch(base + '/v1/teams/' + missionId, {
    headers: { authorization: 'Bearer ' + token }
  });
  assert.equal(inspect.status, 200);
  const after = (await inspect.json() as any).mission;
  assert.equal(after.state, 'PAUSED');
  assert.equal(after.resources.find((item: any) => item.key === resource).uncertain, true);
});
