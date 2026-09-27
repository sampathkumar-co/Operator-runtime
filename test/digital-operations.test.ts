import assert from 'node:assert/strict';
import crypto from 'node:crypto';
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
    organizations: new OrganizationCoordinator(state, teams),
    availableCapabilities: ['project.inspect', 'file.read', 'file.write', 'browser.interact', 'terminal.session']
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
    source: 'project.inspect', domain: 'project', evidenceDigest: 'd'.repeat(64),
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


test('stage10 requestId is idempotent for identical contract and rejects conflicting reuse', async (t) => {
  const { ops } = await setup(t);
  const requestId = crypto.randomUUID();
  const request = {
    requestId,
    objective: 'Idempotent operation',
    scopeKey: 'project:idempotent',
    successConditions: ['verified'],
    execution: { kind: 'team' as const, workItems: work() },
    run: false
  };
  const first = await ops.submit(request);
  const second = await ops.submit(structuredClone(request));
  assert.equal(second.id, first.id);
  assert.equal(second.teamMissionId, first.teamMissionId);
  assert.equal(second.submissionDigest, first.submissionDigest);

  await assert.rejects(
    ops.submit({ ...request, objective: 'Different contract' }),
    (error: any) => error?.code === 'OPERATIONS_REQUEST_CONFLICT'
  );
});


test('stage10 outcome-only submit decomposes into bounded team work without caller-supplied execution graph', async (t) => {
  const { ops, teams } = await setup(t);
  const requestId = crypto.randomUUID();
  const request = {
    requestId,
    objective: 'Repair one project state and verify it',
    scopeKey: 'project:auto',
    successConditions: ['the intended state is observable', 'independent verification passes'],
    maxRisk: 'write' as const,
    authority: {
      capabilities: ['project.inspect', 'file.read', 'file.write'],
      resources: ['file:/workspace/auto.txt']
    },
    run: false
  };

  const first = await ops.submit(request);
  assert.equal(first.mode, 'team');
  assert.match(first.planDigest ?? '', /^[0-9a-f]{64}$/);
  assert.ok(first.teamMissionId);

  const mission = await teams.inspect(first.teamMissionId!);
  assert.deepEqual(mission.workItems.map((item) => item.key), ['plan', 'execute-write', 'test', 'verify']);
  assert.equal(mission.workItems.at(-1)?.role, 'verifier');
  assert.ok(mission.workItems.every((item) => !(item.allowedCapabilities ?? []).includes('browser.interact')));
  assert.ok(mission.workItems.every((item) => !(item.allowedCapabilities ?? []).includes('terminal.session')));
  assert.ok(mission.workItems.every((item) => JSON.stringify(item.resources) === JSON.stringify(['file:/workspace/auto.txt'])));

  const replay = await ops.submit(structuredClone(request));
  assert.equal(replay.id, first.id);
  assert.equal(replay.teamMissionId, first.teamMissionId);
  assert.equal(replay.planDigest, first.planDigest);

  await assert.rejects(
    ops.submit({ ...request, maxRisk: 'read' as const }),
    (error: any) => error?.code === 'OPERATIONS_REQUEST_CONFLICT'
  );
});


test('stage10 world postcondition follows the resolved value rather than any stale minority claim', async (t) => {
  const { ops, world, teams } = await setup(t);
  const operation = await ops.submit({
    objective: 'Verify dominant world state',
    scopeKey: 'project:dominant',
    successConditions: ['resolved service state must be healthy'],
    postconditions: [{
      entityKey: 'service:dominant',
      factKey: 'state',
      expectedValueDigest: worldValueDigest('healthy')
    }],
    execution: { kind: 'team', workItems: work() },
    run: true
  });
  await finishTeam(teams, operation.teamMissionId!);

  await world.observe({
    entity: { key: 'service:dominant', type: 'service', scopeKey: 'project:dominant', label: 'Dominant service' },
    source: 'old-check', domain: 'application', evidenceDigest: '7'.repeat(64),
    facts: { state: 'healthy' }, confidence: 0.55
  });
  await world.observe({
    entity: { key: 'service:dominant', type: 'service', scopeKey: 'project:dominant', label: 'Dominant service' },
    source: 'verifier-a', domain: 'application', evidenceDigest: '8'.repeat(64),
    facts: { state: 'broken' }, confidence: 0.97
  });
  await world.observe({
    entity: { key: 'service:dominant', type: 'service', scopeKey: 'project:dominant', label: 'Dominant service' },
    source: 'verifier-b', domain: 'browser', evidenceDigest: '9'.repeat(64),
    facts: { state: 'broken' }, confidence: 0.96
  });

  const resolved = await world.resolveFact('service:dominant', 'state');
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.value, 'broken');
  assert.ok(resolved.claims.some((claim) => claim.valueDigest === worldValueDigest('healthy')));

  const checked = await ops.refresh(operation.id);
  assert.equal(checked.state, 'BLOCKED');
  assert.match(checked.lastBlockReason ?? '', /resolved value does not match/);
});


test('stage10 compensates a newly created team mission when start fails before operation persistence', async (t) => {
  const state = await tempDir(t);
  const cancelled: string[] = [];
  const missionId = crypto.randomUUID();
  const fakeTeams = {
    async submit() { return { id: missionId }; },
    async start() { throw new Error('simulated start failure'); },
    async cancel(id: string) { cancelled.push(id); return { id, state: 'CANCELLED' }; }
  };
  const registry = new DeviceRegistryStore(state);
  const routing = new DeviceRoutingStore(state, registry);
  const procedures = new ProcedureMemoryStore(state);
  const world = new WorldModelStore(state);
  const optimizer = new ExecutionOptimizerStore(state);
  const fakeOrganizations = {
    async create() { throw new Error('not expected'); },
    async cancel() { return undefined; }
  };
  const ops = new DigitalOperationsLayer(state, {
    procedures,
    world,
    devices: new DevicePoolScheduler(state, registry, routing),
    optimizer,
    teams: fakeTeams as any,
    organizations: fakeOrganizations as any,
    availableCapabilities: ['file.read']
  });

  await assert.rejects(
    ops.submit({
      objective: 'Fail during start',
      scopeKey: 'project:cleanup',
      successConditions: ['must not orphan execution'],
      execution: { kind: 'team', workItems: work() },
      run: true
    }),
    /simulated start failure/
  );
  assert.deepEqual(cancelled, [missionId]);
  assert.deepEqual(await ops.list(), []);
});

test('stage10 organization procedure capture hashes every target Stage4 verifier result', async (t) => {
  const { ops, organizations, teams, procedures } = await setup(t);
  const operation = await ops.submit({
    objective: 'Verify organization rollout evidence',
    scopeKey: 'org:proof',
    successConditions: ['target verifier passes'],
    execution: {
      kind: 'organization',
      targets: [{ key: 'service-a', scopeKey: 'org:proof:service-a', workItems: work() }],
      policy: { canarySize: 1, waveSize: 1, maxParallel: 1, allowedScopePrefixes: ['org:proof'] }
    },
    captureProcedure: {
      key: 'org-rollout-proof',
      title: 'Organization rollout proof',
      objectiveKind: 'org-rollout',
      assumptions: [],
      steps: [{ capability: 'file.read', risk: 'read', summary: 'Inspect and verify target.' }]
    },
    run: true
  });
  assert.ok(operation.organizationProgramId);
  let program = await organizations.inspect(operation.organizationProgramId!);
  const target = program.targets[0]!;
  assert.ok(target.missionId);
  await finishTeam(teams, target.missionId!);

  let refreshed = await ops.refresh(operation.id);
  assert.equal(refreshed.state, 'PAUSED');
  refreshed = await ops.promoteOrganization(operation.id, 'a'.repeat(64));
  assert.equal(refreshed.state, 'RUNNING');
  refreshed = await ops.refresh(operation.id);
  assert.equal(refreshed.state, 'VERIFIED');

  program = await organizations.inspect(operation.organizationProgramId!);
  const mission = await teams.inspect(target.missionId!);
  const verifier = mission.workItems.find((item) => item.role === 'verifier' && item.result?.verificationPassed === true)!;
  const expectedEvidence = {
    programId: program.id,
    waves: program.waves.map((wave) => ({ index: wave.index, promotionDigest: wave.promotionDigest ?? null, state: wave.state })),
    targetVerifications: [{
      targetKey: target.key,
      missionId: mission.id,
      verifierWorkItemId: verifier.id,
      result: verifier.result
    }]
  };
  const expectedDigest = crypto.createHash('sha256').update(JSON.stringify(expectedEvidence)).digest('hex');
  const captured = (await procedures.list()).find((item) => item.key === 'org-rollout-proof');
  assert.ok(captured);
  assert.equal(captured!.verifierEvidenceDigest, expectedDigest);
});


test('stage10 final outcome replay after a crash does not double-learn or double-count procedure reuse', async (t) => {
  const { state, ops, world, procedures, teams, optimizer } = await setup(t);
  const scope = 'project:retry-learning';
  const procedure = await procedures.recordVerified({
    key: 'retry-learning',
    title: 'Retry learning',
    objectiveKind: 'maintenance',
    scopeKey: scope,
    steps: [{ capability: 'file.read', risk: 'read', summary: 'Inspect.' }],
    assumptions: [],
    verificationDigest: 'a'.repeat(64),
    verifierEvidenceDigest: 'b'.repeat(64)
  });
  await world.observe({
    entity: { key: 'service:retry-learning', type: 'service', scopeKey: scope, label: 'Retry service' },
    source: 'trusted-check', domain: 'application', evidenceDigest: 'c'.repeat(64),
    facts: { state: 'healthy' }, confidence: 0.99
  });
  const operation = await ops.submit({
    objective: 'Verify retry-safe learning',
    scopeKey: scope,
    successConditions: ['verified'],
    postconditions: [{
      entityKey: 'service:retry-learning',
      factKey: 'state',
      expectedValueDigest: worldValueDigest('healthy')
    }],
    procedure: { objectiveKind: 'maintenance', assumptions: [], requiredCapabilities: ['file.read'] },
    execution: { kind: 'team', workItems: work() },
    run: true
  });
  assert.equal(operation.selectedProcedureId, procedure.id);
  await finishTeam(teams, operation.teamMissionId!);
  const first = await ops.refresh(operation.id);
  assert.equal(first.state, 'VERIFIED');
  assert.equal(first.outcomeRecorded, true);

  const procedureAfterFirst = (await procedures.list()).find((item) => item.id === procedure.id)!;
  const optimizerAfterFirst = (await optimizer.inspect()).find((item) => item.strategy === 'procedure:' + procedure.id)!;
  assert.equal(procedureAfterFirst.verifiedRuns, 2);
  assert.equal(optimizerAfterFirst.verified, 1);

  const operationFile = path.join(state, 'digital-operations.json');
  const persisted = JSON.parse(await fs.readFile(operationFile, 'utf8'));
  persisted.operations.find((item: any) => item.id === operation.id).outcomeRecorded = false;
  await fs.writeFile(operationFile, JSON.stringify(persisted, null, 2));

  const replay = await ops.refresh(operation.id);
  assert.equal(replay.state, 'VERIFIED');
  assert.equal(replay.outcomeRecorded, true);
  const procedureAfterReplay = (await procedures.list()).find((item) => item.id === procedure.id)!;
  const optimizerAfterReplay = (await optimizer.inspect()).find((item) => item.strategy === 'procedure:' + procedure.id)!;
  assert.equal(procedureAfterReplay.verifiedRuns, 2);
  assert.equal(optimizerAfterReplay.verified, 1);
  assert.equal(optimizerAfterReplay.samples, 1);
});


test('stage10 outcome-only mutation fails closed without an explicit authority envelope', async (t) => {
  const { ops } = await setup(t);
  await assert.rejects(
    ops.submit({
      objective: 'Do not infer write authority',
      scopeKey: 'project:no-authority',
      successConditions: ['verified'],
      maxRisk: 'write',
      run: false
    }),
    (error: any) => error?.code === 'OUTCOME_PLAN_AUTHORITY_REQUIRED'
  );
});
