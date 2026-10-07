import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DeviceIdentityStore } from '../src/core/device-identity.ts';
import { createTask } from '../src/core/task.ts';
import { TaskStore } from '../src/core/task-store.ts';
import { ApprovalStore } from '../apps/local-agent/src/approval-store.ts';
import { createRuntime } from '../apps/local-agent/src/runtime-factory.ts';
import { createLocalAgentServer } from '../apps/local-agent/src/server.ts';

test('R4 Control Center APIs project authenticated runtime truth without leaking authority secrets', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-r4-root-'));
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-r4-state-'));
  t.after(() => Promise.all([
    fs.rm(root, { recursive: true, force: true }),
    fs.rm(state, { recursive: true, force: true })
  ]));

  const tasks = new TaskStore(state);
  const task = createTask({
    userObjective: 'Complete the guided R4 task',
    interpretedObjective: 'Exercise product projections',
    authorizedScope: [root],
    prohibitedScope: [],
    successConditions: ['runtime truth is visible']
  });
  await tasks.put(task);

  const deviceIdentity = new DeviceIdentityStore(state, { platform: 'linux' });
  await deviceIdentity.loadOrCreate('R4 Test Device');

  const approvals = new ApprovalStore(state, {
    clock: () => new Date('2026-10-07T08:00:00.000Z')
  });
  await approvals.register({
    id: 'r4-pending-action',
    capability: 'file.replace',
    risk: 'destructive',
    target: path.join(root, 'important.txt'),
    input: { path: path.join(root, 'important.txt') },
    provenance: { kind: 'runtime' }
  });

  const runtime = createRuntime({ allowedRoots: [root], allowedExecutables: ['node'] });
  const token = 'a'.repeat(64);
  const recoveryToken = 'r'.repeat(64);
  const agent = createLocalAgentServer({
    runtime,
    token,
    recoveryToken,
    tasks,
    approvals,
    deviceIdentity,
    permissions: {
      allowedCapabilities: ['computer.inspect', 'file.*'],
      allowedRoots: [root]
    },
    getRuntimeStatus: () => ({
      relay: { state: 'CONNECTED', configured: true, required: true, continuity: 'automatic' }
    })
  });
  t.after(() => Promise.allSettled([agent.close(), runtime.close()]));

  const bound = await agent.listen('127.0.0.1', 0);
  const base = `http://127.0.0.1:${bound.port}`;
  const headers = { authorization: `Bearer ${token}` };

  for (const route of [
    '/v1/control-center/approvals',
    '/v1/control-center/recovery',
    '/v1/control-center/onboarding',
    '/v1/control-center/diagnostics'
  ]) {
    const denied = await fetch(base + route);
    assert.equal(denied.status, 401, route + ' must remain behind bearer authority');
  }

  const approvalsResponse = await fetch(base + '/v1/control-center/approvals', { headers });
  assert.equal(approvalsResponse.status, 200);
  const approvalBody = await approvalsResponse.json() as any;
  assert.equal(approvalBody.model.counts.pending, 1);
  assert.equal(approvalBody.model.pending[0].effectClass, 'DESTRUCTIVE_EFFECT');
  assert.equal(approvalBody.model.pending[0].reversibility, 'MAY_BE_IRREVERSIBLE');
  assert.equal(approvalBody.model.pending[0].canApprove, true);

  const recoveryResponse = await fetch(base + '/v1/control-center/recovery', { headers });
  assert.equal(recoveryResponse.status, 200);
  const recoveryBody = await recoveryResponse.json() as any;
  assert.deepEqual(recoveryBody.model.items, []);

  const onboardingResponse = await fetch(base + '/v1/control-center/onboarding', { headers });
  assert.equal(onboardingResponse.status, 200);
  const onboardingBody = await onboardingResponse.json() as any;
  assert.equal(onboardingBody.model.completed, false);
  assert.equal(onboardingBody.model.nextStep, 'READ_PROBE');
  assert.equal(onboardingBody.model.steps.find((step: any) => step.id === 'APPROVAL_PROBE').status, 'BLOCKED');
  assert.equal(onboardingBody.evidence.configuredRootCount, 1);

  const diagnosticsResponse = await fetch(base + '/v1/control-center/diagnostics', { headers });
  assert.equal(diagnosticsResponse.status, 200);
  const diagnosticsBody = await diagnosticsResponse.json() as any;
  assert.equal(diagnosticsBody.diagnostics.recoveryConfigured, true);
  assert.equal(diagnosticsBody.diagnostics.authorizedRootCount, 1);
  assert.equal(diagnosticsBody.diagnostics.device.configured, true);
  assert.equal(diagnosticsBody.diagnostics.approvalCounts.pending, 1);
  const serialized = JSON.stringify(diagnosticsBody);
  assert.equal(serialized.includes(token), false);
  assert.equal(serialized.includes(recoveryToken), false);
  assert.equal(serialized.includes(root), false);
  assert.equal(serialized.includes('privateKey'), false);
});
