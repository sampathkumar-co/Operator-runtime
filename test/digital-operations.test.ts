import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProcedureMemoryStore, assumptionFingerprint } from '../src/core/procedure-memory.ts';
import { WorldModelStore, worldValueDigest } from '../src/core/world-model.ts';
import { DeviceRegistryStore } from '../src/core/device-registry.ts';
import { DeviceIdentityStore } from '../src/core/device-identity.ts';
import { DeviceRoutingStore } from '../src/core/device-routing.ts';
import { DevicePoolScheduler } from '../src/core/device-pool.ts';
import { ExecutionOptimizerStore } from '../src/core/execution-optimizer.ts';
import { TeamCoordinator, type TeamWorkInput } from '../src/core/team-coordinator.ts';
import { OrganizationCoordinator } from '../src/core/organization-coordinator.ts';
import { DigitalOperationsLayer, digitalOperationChildId } from '../src/core/digital-operations.ts';
import { DurableCompensationJournal } from '../src/core/compensation-journal.ts';

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
  assert.match(verified.verificationEvidenceDigest ?? '', /^[0-9a-f]{64}$/);
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

test('stage10 creation cleanup persists compensation failure and restart recovery completes it', async (t) => {
  const base = await setup(t);
  let reservationId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  let failRelease = true;
  let releases = 0;
  const devices = {
    async reserve(_req: unknown, _ads: unknown, options?: { reservationId?: string }) {
      reservationId = options?.reservationId ?? reservationId;
      return {
        id: reservationId, sessionId, deviceId: crypto.randomUUID(), state: 'ACTIVE',
        acquiredAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString()
      };
    },
    async release(id: string) {
      assert.equal(id, reservationId);
      releases += 1;
      if (failRelease) throw Object.assign(new Error('release unavailable'), { code: 'DEVICE_RELEASE_UNAVAILABLE' });
      return { id, state: 'RELEASED' };
    }
  };
  const teams = {
    async submit() { throw new Error('mission creation failed'); },
    async cancel() { throw Object.assign(new Error('mission absent'), { code: 'TEAM_NOT_FOUND' }); }
  };
  const compensations = new DurableCompensationJournal(base.state);
  const ops = new DigitalOperationsLayer(base.state, { ...base, devices: devices as any, teams: teams as any, compensations });
  await assert.rejects(() => ops.submit({
    objective: 'Fail after reservation', scopeKey: 'project:compensation', successConditions: ['not leaked'],
    execution: { kind: 'team', workItems: work() },
    device: { request: { workloadKey: 'job:cleanup' }, advertisements: [] }
  }), (error: any) => error?.code === 'COMPENSATION_BLOCKED');
  assert.equal((await compensations.pending('digital-operation')).length, 1);
  assert.equal(releases, 1);

  failRelease = false;
  const recovered = await ops.recoverPendingCompensations();
  assert.deepEqual(recovered, { recovered: 1, pending: 0 });
  assert.equal(releases, 2);
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


test('stage10 rejects a persisted verified receipt that is detached from its bound verification evidence', async (t) => {
  const base = await setup(t);
  const operation = await base.ops.submit({
    objective: 'Produce one bound verification receipt',
    scopeKey: 'project:receipt-proof',
    successConditions: ['team verifier passes'],
    execution: { kind: 'team', workItems: work() },
    run: true
  });
  assert.ok(operation.teamMissionId);
  await finishTeam(base.teams, operation.teamMissionId!);
  const verified = await base.ops.refresh(operation.id);
  assert.equal(verified.state, 'VERIFIED');
  assert.match(verified.verificationEvidenceDigest ?? '', /^[0-9a-f]{64}$/);

  const file = path.join(base.state, 'digital-operations.json');
  const persisted = JSON.parse(await fs.readFile(file, 'utf8'));
  const record = persisted.operations.find((item: any) => item.id === operation.id);
  record.receiptDigest = '0'.repeat(64);
  await fs.writeFile(file, JSON.stringify(persisted, null, 2));

  const restarted = new DigitalOperationsLayer(base.state, {
    procedures: base.procedures,
    world: base.world,
    devices: base.devices,
    optimizer: base.optimizer,
    teams: base.teams,
    organizations: base.organizations,
    availableCapabilities: base.availableCapabilities
  });
  await assert.rejects(
    () => restarted.inspect(operation.id),
    (error: any) => error?.code === 'OPERATIONS_STATE_CORRUPT'
  );
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

test('stage10 running operation renews its device reservation and blocks visibly on reservation loss', async (t) => {
  const base = await setup(t);
  let reservationId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  let heartbeats = 0;
  let loseReservation = false;
  let nowMs = Date.parse('2026-01-01T00:00:00.000Z');
  let expiresAtMs = nowMs + 10_000;
  let activeWorkload = '';
  const devices = {
    async reserve(request: { workloadKey: string }, _ads?: unknown, options?: { reservationId?: string }) {
      reservationId = options?.reservationId ?? reservationId;
      if (activeWorkload && activeWorkload !== request.workloadKey && nowMs < expiresAtMs) throw Object.assign(new Error('capacity held'), { code: 'DEVICE_POOL_NO_ELIGIBLE_DEVICE' });
      activeWorkload = request.workloadKey;
      expiresAtMs = nowMs + 10_000;
      const now = new Date(nowMs).toISOString();
      return { id: reservationId, sessionId, deviceId: crypto.randomUUID(), acquiredAt: now, heartbeatAt: now, expiresAt: new Date(expiresAtMs).toISOString(), state: 'ACTIVE' };
    },
    async heartbeat(id: string, session: string) {
      heartbeats += 1;
      assert.equal(id, reservationId); assert.equal(session, sessionId);
      if (loseReservation) throw Object.assign(new Error('lost'), { code: 'DEVICE_POOL_RESERVATION_LOST' });
      expiresAtMs = nowMs + 10_000;
      return { id, sessionId: session, state: 'ACTIVE', heartbeatAt: new Date(nowMs).toISOString(), expiresAt: new Date(expiresAtMs).toISOString() };
    },
    async release() { return {}; }
  };
  const ops = new DigitalOperationsLayer(base.state, { ...base, devices: devices as any, clock: () => new Date(nowMs) });
  const operation = await ops.submit({
    objective: 'Hold device capacity', scopeKey: 'project:device', successConditions: ['verified'],
    execution: { kind: 'team', workItems: work() },
    device: { request: { workloadKey: 'job:held', leaseMs: 10_000 }, advertisements: [] }, run: true
  });
  nowMs += 9_000;
  const running = await ops.refresh(operation.id);
  assert.equal(running.state, 'RUNNING');
  assert.equal(heartbeats, 1);
  nowMs += 9_000;
  await assert.rejects(
    () => devices.reserve({ workloadKey: 'job:second' }),
    (error: any) => error?.code === 'DEVICE_POOL_NO_ELIGIBLE_DEVICE'
  );
  loseReservation = true;
  const blocked = await ops.refresh(operation.id);
  assert.equal(blocked.state, 'BLOCKED');
  assert.match(blocked.lastBlockReason ?? '', /DEVICE_POOL_RESERVATION_LOST/);
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
  let missionId = crypto.randomUUID();
  const fakeTeams = {
    async submit(input: { missionId: string }) { missionId = input.missionId; return { id: missionId }; },
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
  program = await organizations.inspect(operation.organizationProgramId!);
  assert.match(program.waves[0]?.verificationDigest ?? '', /^[0-9a-f]{64}$/);
  await assert.rejects(
    () => ops.promoteOrganization(operation.id, 'a'.repeat(64)),
    (error: any) => error?.code === 'ORGANIZATION_VERIFICATION_DIGEST_MISMATCH'
  );
  refreshed = await ops.promoteOrganization(operation.id, program.waves[0]!.verificationDigest!);
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



test('write-ahead compensation journal failure prevents allocation entirely', async (t) => {
  const base = await setup(t);
  let allocations = 0;
  const devices = {
    async reserve() { allocations++; throw new Error('allocation should not occur'); },
    async release() { throw new Error('allocation should not exist'); }
  };
  const compensations = new DurableCompensationJournal(base.state);
  compensations.prepare = async () => {
    throw Object.assign(new Error('synthetic journal fault'), { code: 'JOURNAL_WRITE_FAILED' });
  };
  const ops = new DigitalOperationsLayer(base.state, { ...base, devices: devices as any, compensations });
  await assert.rejects(ops.submit({
    objective: 'Persist intent before capacity', scopeKey: 'project:write-ahead',
    successConditions: ['bounded'], execution: { kind: 'team', workItems: work() },
    device: { request: { workloadKey: 'job:write-ahead' }, advertisements: [] }
  }), /synthetic journal fault/);
  assert.equal(allocations, 0);
  assert.deepEqual(await compensations.pending('digital-operation'), []);
});

test('lost reservation response is reconciled using the preassigned durable identity', async (t) => {
  const base = await setup(t);
  let reservationId = '';
  let allocations = 0;
  let failRelease = true;
  let releases = 0;
  const devices = {
    async reserve(_req: unknown, _ads: unknown, options: { reservationId: string }) {
      reservationId = options.reservationId;
      allocations++;
      throw Object.assign(new Error('response lost after commit'), { code: 'DEVICE_RESPONSE_LOST' });
    },
    async release(id: string) {
      assert.equal(id, reservationId);
      releases++;
      if (failRelease) throw Object.assign(new Error('release unavailable'), { code: 'DEVICE_RELEASE_UNAVAILABLE' });
      return { id, state: 'RELEASED' };
    }
  };
  const compensations = new DurableCompensationJournal(base.state);
  const ops = new DigitalOperationsLayer(base.state, { ...base, devices: devices as any, compensations });
  await assert.rejects(ops.submit({
    objective: 'Reconcile lost allocation response', scopeKey: 'project:lost-response',
    successConditions: ['no resource leak'], execution: { kind: 'team', workItems: work() },
    device: { request: { workloadKey: 'job:lost-response' }, advertisements: [] }
  }), (error: any) => error?.code === 'COMPENSATION_BLOCKED' &&
    error?.details?.reservationId === reservationId &&
    error?.details?.reserveCode === 'DEVICE_RESPONSE_LOST' &&
    error?.details?.cleanupCode === 'DEVICE_RELEASE_UNAVAILABLE');
  assert.equal(allocations, 1);
  assert.equal((await compensations.pending('digital-operation')).length, 1);
  failRelease = false;
  const restarted = new DigitalOperationsLayer(base.state, { ...base, devices: devices as any, compensations: new DurableCompensationJournal(base.state) });
  assert.deepEqual(await restarted.recoverPendingCompensations(), { recovered: 1, pending: 0 });
  assert.equal(allocations, 1);
  assert.equal(releases, 2);
});

test('restart after reservation commit and before operation commit releases exactly the orphaned resource', async (t) => {
  const base = await setup(t);
  const registry = new DeviceRegistryStore(base.state);
  const routing = new DeviceRoutingStore(base.state, registry);
  const devices = new DevicePoolScheduler(base.state, registry, routing);
  const peer = await new DeviceIdentityStore(await tempDir(t), { platform: 'linux' }).loadOrCreate('crash-peer');
  await registry.registerVerifiedPeer(peer);
  const ownerId = crypto.randomUUID();
  const reservationId = digitalOperationChildId(ownerId, 'release-device-reservation');
  const compensations = new DurableCompensationJournal(base.state);
  const recoveryId = crypto.createHash('sha256').update(['digital-operation', ownerId, 'release-device-reservation', reservationId].join('\0')).digest('hex');
  await compensations.prepare({
    id: recoveryId, ownerKind: 'digital-operation', ownerId,
    operation: 'release-device-reservation', targetId: reservationId
  });
  const sessionId = crypto.randomUUID();
  const reservation = await devices.reserve({ workloadKey: 'work:crash-window' }, [{
    deviceId: peer.deviceId, sessionId, capabilities: ['file.read'],
    observedAt: new Date().toISOString(), cpuSlots: 4, memoryMb: 8192,
    gpu: false, tags: [], activeJobs: 0, maxConcurrentJobs: 1
  }], { reservationId });
  assert.equal(reservation.id, reservationId);
  assert.equal((await devices.list({ activeOnly: true })).length, 1);
  const restarted = new DigitalOperationsLayer(base.state, {
    ...base, devices: new DevicePoolScheduler(base.state, registry, routing),
    compensations: new DurableCompensationJournal(base.state)
  });
  assert.deepEqual(await restarted.recoverPendingCompensations(), { recovered: 1, pending: 0 });
  assert.equal((await devices.list({ activeOnly: true })).length, 0);
  assert.deepEqual(await compensations.pending('digital-operation'), []);
});

test('team mission response loss keeps write-ahead cancel intent across restart without replaying creation', async (t) => {
  const base = await setup(t);
  let missionId = '';
  let creates = 0;
  let cancels = 0;
  let allowCancel = false;
  const teams = {
    async submit(input: { missionId: string }) {
      missionId = input.missionId; creates++;
      throw Object.assign(new Error('mission created but response lost'), { code: 'TEAM_RESPONSE_LOST' });
    },
    async cancel(id: string) {
      assert.equal(id, missionId); cancels++;
      if (!allowCancel) throw Object.assign(new Error('cleanup unavailable'), { code: 'TEAM_CANCEL_UNAVAILABLE' });
      return { id, state: 'CANCELLED' };
    }
  };
  const compensations = new DurableCompensationJournal(base.state);
  const ops = new DigitalOperationsLayer(base.state, { ...base, teams: teams as any, compensations });
  await assert.rejects(ops.submit({
    objective: 'Recover unacknowledged mission', scopeKey: 'project:lost-team',
    successConditions: ['no duplicate work'], execution: { kind: 'team', workItems: work() }
  }), (error: any) => error?.code === 'COMPENSATION_BLOCKED');
  const pending = await compensations.pending('digital-operation');
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.operation, 'cancel-team-mission');
  assert.equal(pending[0]?.targetId, missionId);
  allowCancel = true;
  const restarted = new DigitalOperationsLayer(base.state, {
    ...base, teams: teams as any, compensations: new DurableCompensationJournal(base.state)
  });
  assert.deepEqual(await restarted.recoverPendingCompensations(), { recovered: 1, pending: 0 });
  assert.equal(creates, 1);
  assert.equal(cancels, 2);
});

test('organization program response loss keeps the exact cancel identity for restart', async (t) => {
  const base = await setup(t);
  let programId = '';
  let creates = 0;
  let cancels = 0;
  let allowCancel = false;
  const organizations = {
    async create(input: { programId: string }) {
      programId = input.programId; creates++;
      throw Object.assign(new Error('program created but response lost'), { code: 'ORG_RESPONSE_LOST' });
    },
    async cancel(id: string) {
      assert.equal(id, programId); cancels++;
      if (!allowCancel) throw Object.assign(new Error('cleanup unavailable'), { code: 'ORG_CANCEL_UNAVAILABLE' });
      return { id, state: 'CANCELLED' };
    }
  };
  const compensations = new DurableCompensationJournal(base.state);
  const ops = new DigitalOperationsLayer(base.state, { ...base, organizations: organizations as any, compensations });
  await assert.rejects(ops.submit({
    objective: 'Recover unacknowledged program', scopeKey: 'org:lost-program',
    successConditions: ['no duplicated rollout'], execution: { kind: 'organization', targets: [
      { key: 'service', scopeKey: 'org:lost-program:service', workItems: work() }
    ] }
  }), (error: any) => error?.code === 'COMPENSATION_BLOCKED');
  const pending = await compensations.pending('digital-operation');
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.operation, 'cancel-organization-program');
  assert.equal(pending[0]?.targetId, programId);
  allowCancel = true;
  const restarted = new DigitalOperationsLayer(base.state, {
    ...base, organizations: organizations as any, compensations: new DurableCompensationJournal(base.state)
  });
  assert.deepEqual(await restarted.recoverPendingCompensations(), { recovered: 1, pending: 0 });
  assert.equal(creates, 1);
  assert.equal(cancels, 2);
});

test('digital operation reconciliation retains intents until cancellation and release postconditions are proved', async (t) => {
  const base = await setup(t);
  const compensations = new DurableCompensationJournal(base.state);
  const ownerId = crypto.randomUUID();
  const teamId = digitalOperationChildId(ownerId, 'cancel-team-mission');
  const programId = digitalOperationChildId(ownerId, 'cancel-organization-program');
  const reservationId = digitalOperationChildId(ownerId, 'release-device-reservation');
  for (const [operation, targetId] of [
    ['cancel-team-mission', teamId],
    ['cancel-organization-program', programId],
    ['release-device-reservation', reservationId]
  ]) {
    await compensations.prepare({
      id: crypto.randomUUID(), ownerKind: 'digital-operation', ownerId, operation, targetId
    });
  }
  let safe = false;
  const teams = { async cancel(id: string) { assert.equal(id, teamId); return { id, state: safe ? 'CANCELLED' : 'VERIFIED' }; } };
  const organizations = { async cancel(id: string) { assert.equal(id, programId); return { id, state: safe ? 'CANCELLED' : 'BLOCKED' }; } };
  const devices = { async release(id: string) { assert.equal(id, reservationId); return { id, state: safe ? 'RELEASED' : 'ACTIVE' }; } };
  const ops = new DigitalOperationsLayer(base.state, {
    ...base, teams: teams as any, organizations: organizations as any,
    devices: devices as any, compensations
  });
  assert.deepEqual(await ops.recoverPendingCompensations(), { recovered: 0, pending: 3 });
  safe = true;
  assert.deepEqual(await ops.recoverPendingCompensations(), { recovered: 3, pending: 0 });
});

test('failed mission start cannot report compensated when its cancellation remained VERIFIED', async (t) => {
  const base = await setup(t);
  const compensations = new DurableCompensationJournal(base.state);
  const teams = {
    async submit(input: { missionId: string }) { return { id: input.missionId }; },
    async start() { throw new Error('simulated startup fault'); },
    async cancel() { return { state: 'VERIFIED' }; }
  };
  const ops = new DigitalOperationsLayer(base.state, { ...base, teams: teams as any, compensations });
  await assert.rejects(ops.submit({
    objective: 'Ensure truthful rollback', scopeKey: 'project:rollback',
    successConditions: ['confirmed cancellation'], execution: { kind: 'team', workItems: work() },
    run: true
  }), (error: any) => error?.code === 'COMPENSATION_BLOCKED');
  const pending = await compensations.pending('digital-operation');
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.operation, 'cancel-team-mission');
});

test('two independent recovery workers never execute one compensation twice',async t=>{
 const base=await setup(t);
 const ownerId=crypto.randomUUID(),missionId=digitalOperationChildId(ownerId,'cancel-team-mission');
 const journal=new DurableCompensationJournal(base.state);
 await journal.prepare({
  id:crypto.randomUUID(),ownerKind:'digital-operation',ownerId,
  operation:'cancel-team-mission',targetId:missionId
 });
 let cancels=0;
 const teams={
  async cancel(id:string){
    assert.equal(id,missionId);cancels+=1;
    await new Promise(resolve=>setTimeout(resolve,120));
    return {id,state:'CANCELLED'};
  }
 };
 const left=new DigitalOperationsLayer(base.state,{...base,teams:teams as any});
 const right=new DigitalOperationsLayer(base.state,{...base,teams:teams as any});
 await Promise.all([left.recoverPendingCompensations(),right.recoverPendingCompensations()]);
 assert.equal(cancels,1,'one compensated identity must have one physical cancel owner');
 assert.equal((await journal.pending('digital-operation')).length,0);
});

test('two independent operation creators reuse one requestId without duplicated mission side effects',async t=>{
 const base=await setup(t);
 let creates=0;
 const teams={
  async submit(input:{missionId:string}){
   creates+=1;
   await new Promise(resolve=>setTimeout(resolve,80));
   return {id:input.missionId,state:'PENDING'};
  },
  async cancel(id:string){return {id,state:'CANCELLED'}}
 };
 const left=new DigitalOperationsLayer(base.state,{...base,teams:teams as any});
 const right=new DigitalOperationsLayer(base.state,{...base,teams:teams as any});
 const input={
  requestId:crypto.randomUUID(),objective:'One bounded workflow',
  scopeKey:'project:duplicate-submission',successConditions:['one mission'],
  execution:{kind:'team' as const,workItems:work()},run:false
 };
 const [a,b]=await Promise.all([left.submit(input),right.submit(input)]);
 assert.equal(a.id,input.requestId);
 assert.equal(b.id,input.requestId);
 assert.equal(a.teamMissionId,b.teamMissionId);
 assert.equal(creates,1);
});

test('external RESOURCE_BUSY error is not mistaken for acquisition contention and retried',async t=>{
 const base=await setup(t);
 let submits=0;
 const teams={
  async submit(){submits++;throw Object.assign(new Error('provider busy after effect attempt'),{code:'RESOURCE_BUSY'})},
  async cancel(id:string){return {id,state:'CANCELLED'}}
 };
 const ops=new DigitalOperationsLayer(base.state,{...base,teams:teams as any});
 await assert.rejects(ops.submit({
  requestId:crypto.randomUUID(),objective:'Do not replay unknown effects',
  scopeKey:'project:no-retry',successConditions:['no duplicate'],
  execution:{kind:'team',workItems:work()}
 }),/provider busy after effect attempt/);
 assert.equal(submits,1);
});

test('independent OS processes execute one pending compensation only once',async t=>{
 const base=await setup(t);
 const id=crypto.randomUUID(), ownerId=crypto.randomUUID();
 const missionId=digitalOperationChildId(ownerId,'cancel-team-mission');
 await new DurableCompensationJournal(base.state).prepare({
  id,ownerKind:'digital-operation',ownerId,
  operation:'cancel-team-mission',targetId:missionId
 });
 const {execFile}=await import('node:child_process');
 const {promisify}=await import('node:util');
 const {pathToFileURL}=await import('node:url');
 const exec=promisify(execFile);
 const url=pathToFileURL(path.resolve('src/core/digital-operations.ts')).href;
 const log=path.join(base.state,'physical-cancels.log');
 const script=`import fs from 'node:fs/promises';
import {DigitalOperationsLayer} from ${JSON.stringify(url)};
const dir=process.argv[1],log=process.argv[2];
const teams={cancel:async id=>{
 await fs.appendFile(log,id+'\\n');
 await new Promise(resolve=>setTimeout(resolve,90));
 return {id,state:'CANCELLED'};
}};
const ops=new DigitalOperationsLayer(dir,{teams});
await ops.recoverPendingCompensations();`;
 await Promise.all(Array.from({length:3},()=>exec(process.execPath,[
  '--experimental-strip-types','--input-type=module','-e',script,base.state,log
 ],{windowsHide:true,cwd:process.cwd(),timeout:30000})));
 const calls=(await fs.readFile(log,'utf8')).trim().split('\n');
 assert.deepEqual(calls,[missionId]);
 assert.equal((await new DurableCompensationJournal(base.state).pending('digital-operation')).length,0);
});

test('unbound digital compensation must not cancel an unrelated team mission', async t => {
  const {state,teams,ops}=await setup(t);
  const unrelated=await teams.submit({
    missionId:crypto.randomUUID(),objective:'Unrelated independent mission',workItems:work()
  });
  await teams.start(unrelated.id);
  const journal=new DurableCompensationJournal(state);
  await journal.prepare({
    id:crypto.randomUUID(),ownerKind:'digital-operation',
    ownerId:crypto.randomUUID(),operation:'cancel-team-mission',
    targetId:unrelated.id
  });
  const result=await ops.recoverPendingCompensations();
  assert.equal(result.recovered,0);
  assert.equal(result.pending,1);
  assert.equal((await teams.inspect(unrelated.id)).state,'RUNNING');
});

test('orphan recovery rejects foreign team, organization and reservation identities', async t => {
  const base = await setup(t);
  const id = crypto.randomUUID(),ownerId=crypto.randomUUID();
  const targets = {
    'cancel-team-mission':crypto.randomUUID(),
    'cancel-organization-program':crypto.randomUUID(),
    'release-device-reservation':crypto.randomUUID()
  };
  const journal=new DurableCompensationJournal(base.state);
  for(const [operation,targetId] of Object.entries(targets)){
    await journal.prepare({ id:crypto.randomUUID(),ownerKind:'digital-operation',
      ownerId,operation,targetId });
  }
  const invocations:string[]=[];
  const teams={async cancel(id:string){ invocations.push('team:'+id);return {id,state:'CANCELLED'} }};
  const organizations={async cancel(id:string){invocations.push('org:'+id);return {id,state:'CANCELLED'} }};
  const devices={async release(id:string){invocations.push('device:'+id);return {id,state:'RELEASED'} }};
  const ops = new DigitalOperationsLayer(base.state,{...base,teams:teams as any,
    organizations:organizations as any,devices:devices as any});
  assert.deepEqual(await ops.recoverPendingCompensations(),{recovered:0,pending:3});
  assert.deepEqual(invocations,[]);
  assert.equal(digitalOperationChildId(ownerId,'cancel-team-mission'),
               digitalOperationChildId(ownerId,'cancel-team-mission'));
  assert.notEqual(digitalOperationChildId(ownerId,'cancel-team-mission'),
                  digitalOperationChildId(ownerId,'cancel-organization-program'));
});
