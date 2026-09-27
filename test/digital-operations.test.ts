import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProcedureMemoryStore, assumptionFingerprint } from '../src/core/procedure-memory.ts';
import { WorldModelStore, worldValueDigest } from '../src/core/world-model.ts';
import { DeviceRegistryStore } from '../src/core/device-registry.ts';
import { DeviceRoutingStore } from '../src/core/device-routing.ts';
import { DevicePoolScheduler } from '../src/core/device-pool.ts';
import { ExecutionOptimizerStore } from '../src/core/execution-optimizer.ts';
import { TeamCoordinator, type TeamWorkInput } from '../src/core/team-coordinator.ts';
import { OrganizationCoordinator } from '../src/core/organization-coordinator.ts';
import { DigitalOperationsLayer } from '../src/core/digital-operations.ts';

async function tempDir(t: test.TestContext): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-digital-ops-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function setup(t: test.TestContext) {
  const state = await tempDir(t);
  const teams = new TeamCoordinator(state);
  const registry = new DeviceRegistryStore(state);
  const routing = new DeviceRoutingStore(state, registry);
  const dependencies = {
    procedures: new ProcedureMemoryStore(state),
    world: new WorldModelStore(state),
    devices: new DevicePoolScheduler(state, registry, routing),
    optimizer: new ExecutionOptimizerStore(state),
    teams,
    organizations: new OrganizationCoordinator(state, teams)
  };
  return { state, teams, ...dependencies, ops: new DigitalOperationsLayer(state, dependencies) };
}

function work(): TeamWorkInput[] {
  return [
    { key: 'act', title: 'Perform bounded work', role: 'general', risk: 'read' },
    { key: 'verify', title: 'Verify outcome', role: 'verifier', risk: 'read', dependsOn: ['act'] }
  ];
}

async function finishTeam(teams: TeamCoordinator, missionId: string): Promise<void> {
  const worker = (await teams.registerWorker(missionId, { role: 'general', label: 'worker' })).worker;
  const verifier = (await teams.registerWorker(missionId, { role: 'verifier', label: 'verifier' })).worker;
  const first = await teams.claim(missionId, { workerId: worker.id });
  await teams.complete(missionId, {
    workerId: worker.id, workItemId: first.workItem!.id, leaseId: first.workItem!.lease!.id, summary: 'done'
  });
  const verify = await teams.claim(missionId, { workerId: verifier.id });
  await teams.complete(missionId, {
    workerId: verifier.id, workItemId: verify.workItem!.id, leaseId: verify.workItem!.lease!.id,
    summary: 'verified', verificationPassed: true,
    evidence: [{ kind: 'verification', status: 'pass', message: 'verified machine outcome' }]
  });
}

test('stage10 binds preconditions, verified procedure memory, team verifier and world postconditions before final verification', async (t) => {
  const { ops, world, procedures, teams, optimizer } = await setup(t);
  const scope = 'project:checkout';
  await world.observe({
    entity: { key: 'service:checkout', type: 'service', scopeKey: scope, label: 'Checkout service' },
    source: 'project.inspect', domain: 'project', evidenceDigest: 'a'.repeat(64),
    facts: { state: 'ready' }, confidence: 0.95
  });
  const assumption = { key: 'runtime', fingerprint: assumptionFingerprint({ node: 22 }) };
  const procedure = await procedures.recordVerified({
    key: 'checkout-maintenance',
    title: 'Verified checkout maintenance',
    objectiveKind: 'maintenance',
    scopeKey: scope,
    steps: [{ capability: 'project.inspect', risk: 'read', summary: 'Inspect and verify.' }],
    assumptions: [assumption],
    verificationDigest: 'b'.repeat(64),
    verifierEvidenceDigest: 'c'.repeat(64)
  });

  const operation = await ops.submit({
    objective: 'Restore checkout and verify it',
    scopeKey: scope,
    successConditions: ['team verifier passes', 'checkout world state is healthy'],
    preconditions: [{ entityKey: 'service:checkout', factKey: 'state', expectedValueDigest: worldValueDigest('ready') }],
    postconditions: [{ entityKey: 'service:checkout', factKey: 'state', expectedValueDigest: worldValueDigest('healthy') }],
    procedure: { objectiveKind: 'maintenance', assumptions: [assumption], requiredCapabilities: ['project.inspect'] },
    execution: { kind: 'team', workItems: work() },
    run: true
  });
  assert.equal(operation.selectedProcedureId, procedure.id);
  assert.ok(operation.teamMissionId);

  await finishTeam(teams, operation.teamMissionId!);
  const blocked = await ops.refresh(operation.id);
  assert.equal(blocked.state, 'BLOCKED');
  assert.match(blocked.lastBlockReason ?? '', /does not match|missing/);

  await world.observe({
    entity: { key: 'service:checkout', type: 'service', scopeKey: scope, label: 'Checkout service' },
    source: 'browser.health', domain: 'browser', evidenceDigest: 'd'.repeat(64),
    facts: { state: 'healthy' }, confidence: 0.98
  });
  const verified = await ops.refresh(operation.id);
  assert.equal(verified.state, 'VERIFIED');
  assert.match(verified.receiptDigest ?? '', /^[0-9a-f]{64}$/);
  assert.equal(verified.outcomeRecorded, true);

  const remembered = (await procedures.list()).find((item) => item.id === procedure.id)!;
  assert.equal(remembered.verifiedRuns, 2);
  const learned = await optimizer.inspect();
  assert.ok(learned.some((item) => item.strategy === 'procedure:' + procedure.id && item.verified === 1));
});

test('stage10 refuses to create execution when declared world precondition is conflicting', async (t) => {
  const { ops, world } = await setup(t);
  await world.observe({
    entity: { key: 'release:state', type: 'release', scopeKey: 'project:r', label: 'Release' },
    source: 'git', domain: 'git', evidenceDigest: 'e'.repeat(64),
    facts: { ready: true }, confidence: 0.8
  });
  await world.observe({
    entity: { key: 'release:state', type: 'release', scopeKey: 'project:r', label: 'Release' },
    source: 'ci', domain: 'other', evidenceDigest: 'f'.repeat(64),
    facts: { ready: false }, confidence: 0.8
  });
  await assert.rejects(
    ops.submit({
      objective: 'Release',
      scopeKey: 'project:r',
      successConditions: ['verified'],
      preconditions: [{ entityKey: 'release:state', factKey: 'ready', expectedValueDigest: worldValueDigest(true) }],
      execution: { kind: 'team', workItems: work() },
      run: true
    }),
    (error: any) => error?.code === 'OPERATIONS_WORLD_CONDITION_FAILED'
  );
});

test('stage10 cancellation records failed strategy outcome exactly once', async (t) => {
  const { ops, optimizer } = await setup(t);
  const operation = await ops.submit({
    objective: 'Cancelable operation',
    scopeKey: 'project:c',
    successConditions: ['verified'],
    execution: { kind: 'team', workItems: work() },
    strategies: [{ id: 'bounded-strategy', staticScore: 0.8 }],
    run: true
  });
  const cancelled = await ops.cancel(operation.id);
  assert.equal(cancelled.state, 'CANCELLED');
  assert.equal(cancelled.outcomeRecorded, true);
  await ops.refresh(operation.id);
  const entries = await optimizer.inspect();
  const entry = entries.find((item) => item.strategy === 'bounded-strategy')!;
  assert.equal(entry.failed, 1);
});

test('stage10 operation cannot verify from worker success alone without Stage4 verifier gate', async (t) => {
  const { ops, teams } = await setup(t);
  const operation = await ops.submit({
    objective: 'Do not trust worker self-report',
    scopeKey: 'project:v',
    successConditions: ['independent verifier required'],
    execution: { kind: 'team', workItems: work() },
    run: true
  });
  const worker = (await teams.registerWorker(operation.teamMissionId!, { role: 'general', label: 'worker' })).worker;
  const claim = await teams.claim(operation.teamMissionId!, { workerId: worker.id });
  await teams.complete(operation.teamMissionId!, {
    workerId: worker.id, workItemId: claim.workItem!.id, leaseId: claim.workItem!.lease!.id, summary: 'I say done'
  });
  const current = await ops.refresh(operation.id);
  assert.notEqual(current.state, 'VERIFIED');
});
