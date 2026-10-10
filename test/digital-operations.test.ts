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
import { DevicePoolScheduler, devicePoolAllocationRequestDigest } from '../src/core/device-pool.ts';
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

test('stage10 unknown child creation quarantines while confirmed device recovery remains possible', async (t) => {
  const base = await setup(t);
  const expectedRequestDigest = devicePoolAllocationRequestDigest({ workloadKey: 'job:cleanup' });
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
    },
    async releasePrepared(id: string, requestDigest: string) {
      assert.equal(requestDigest, expectedRequestDigest);
      return await this.release(id);
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
  const pending = await compensations.pending('digital-operation');
  assert.equal(pending.length, 3);
  assert.ok(pending.some(item=>item.operation==='cancel-team-mission' && !item.confirmedAt));
  assert.ok(pending.some(item=>item.operation==='reconcile-unacknowledged-team-mission'));
  assert.ok(pending.some(item=>item.operation==='release-device-reservation' && item.confirmedAt));
  assert.equal(releases, 0);

  failRelease = false;
  const recovered = await ops.recoverPendingCompensations();
  assert.deepEqual(recovered, { recovered: 1, pending: 2 });
  assert.equal(releases, 1);
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

test('lost reservation response remains quarantined without speculative release', async (t) => {
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
    error?.details?.reserveCode === 'DEVICE_RESPONSE_LOST');
  assert.equal(allocations, 1);
  const pending = await compensations.pending('digital-operation');
  assert.equal(pending.length, 2);
  assert.ok(pending.every(intent => !intent.confirmedAt));
  failRelease = false;
  const restarted = new DigitalOperationsLayer(base.state, { ...base, devices: devices as any, compensations: new DurableCompensationJournal(base.state) });
  assert.deepEqual(await restarted.recoverPendingCompensations(), { recovered: 0, pending: 2 });
  assert.equal(allocations, 1);
  assert.equal(releases, 0);
});

test('restart after confirmed reservation commit safely releases the orphaned resource', async (t) => {
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
    operation: 'release-device-reservation', targetId: reservationId,
    allocationRequestDigest: devicePoolAllocationRequestDigest({ workloadKey: 'work:crash-window' })
  });
  const sessionId = crypto.randomUUID();
  const reservation = await devices.reserve({ workloadKey: 'work:crash-window' }, [{
    deviceId: peer.deviceId, sessionId, capabilities: ['file.read'],
    observedAt: new Date().toISOString(), cpuSlots: 4, memoryMb: 8192,
    gpu: false, tags: [], activeJobs: 0, maxConcurrentJobs: 1
  }], { reservationId });
  assert.equal(reservation.id, reservationId);
  // Model a successful provider acknowledgement durably persisted before the crash.
  await compensations.confirm(recoveryId);
  assert.equal((await devices.list({ activeOnly: true })).length, 1);
  const restarted = new DigitalOperationsLayer(base.state, {
    ...base, devices: new DevicePoolScheduler(base.state, registry, routing),
    compensations: new DurableCompensationJournal(base.state)
  });
  assert.deepEqual(await restarted.recoverPendingCompensations(), { recovered: 1, pending: 0 });
  assert.equal((await devices.list({ activeOnly: true })).length, 0);
  assert.deepEqual(await compensations.pending('digital-operation'), []);
});

test('team mission lost acknowledgement remains quarantined without replay or cancellation', async (t) => {
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
  assert.equal(pending.length, 2);
  assert.ok(pending.every(intent => !intent.confirmedAt));
  assert.ok(pending.some(intent => intent.operation === 'cancel-team-mission'));
  assert.ok(pending.some(intent => intent.targetId === missionId));
  allowCancel = true;
  const restarted = new DigitalOperationsLayer(base.state, {
    ...base, teams: teams as any, compensations: new DurableCompensationJournal(base.state)
  });
  assert.deepEqual(await restarted.recoverPendingCompensations(), { recovered: 0, pending: 2 });
  assert.equal(creates, 1);
  assert.equal(cancels, 0);
});

test('organization program lost acknowledgement remains quarantined across restart', async (t) => {
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
  assert.equal(pending.length, 2);
  assert.ok(pending.every(intent => !intent.confirmedAt));
  assert.ok(pending.some(intent => intent.operation === 'cancel-organization-program'));
  assert.ok(pending.some(intent => intent.targetId === programId));
  allowCancel = true;
  const restarted = new DigitalOperationsLayer(base.state, {
    ...base, organizations: organizations as any, compensations: new DurableCompensationJournal(base.state)
  });
  assert.deepEqual(await restarted.recoverPendingCompensations(), { recovered: 0, pending: 2 });
  assert.equal(creates, 1);
  assert.equal(cancels, 0);
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
    const prepared = await compensations.prepare({
      id: crypto.randomUUID(), ownerKind: 'digital-operation', ownerId, operation, targetId,
      ...(operation === 'release-device-reservation'
        ? { allocationRequestDigest: devicePoolAllocationRequestDigest({ workloadKey: 'verified-recovery' }) } : {})
    });
    await compensations.confirm(prepared.id);
  }
  let safe = false;
  const teams = { async cancel(id: string) { assert.equal(id, teamId); return { id, state: safe ? 'CANCELLED' : 'VERIFIED' }; } };
  const organizations = { async cancel(id: string) { assert.equal(id, programId); return { id, state: safe ? 'CANCELLED' : 'BLOCKED' }; } };
  const devices = {
    async release() { throw new Error('unfenced legacy release must not run'); },
    async releasePrepared(id: string, digest: string) {
      assert.equal(id, reservationId);
      assert.equal(digest, devicePoolAllocationRequestDigest({ workloadKey: 'verified-recovery' }));
      return { id, state: safe ? 'RELEASED' : 'ACTIVE' };
    }
  };
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
 const prepared=await journal.prepare({
  id:crypto.randomUUID(),ownerKind:'digital-operation',ownerId,
  operation:'cancel-team-mission',targetId:missionId
 });
 await journal.confirm(prepared.id);
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

test('external RESOURCE_BUSY response is quarantined without retrying the attempted effect',async t=>{
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
 }), (error:any) => error?.code === 'COMPENSATION_BLOCKED' && /acknowledgement is missing/.test(error.message));
 assert.equal(submits,1);
 assert.ok((await new DurableCompensationJournal(base.state).pending('digital-operation')).length > 0);
});

test('independent OS processes execute one pending compensation only once',async t=>{
 const base=await setup(t);
 const id=crypto.randomUUID(), ownerId=crypto.randomUUID();
 const missionId=digitalOperationChildId(ownerId,'cancel-team-mission');
 const journal = new DurableCompensationJournal(base.state);
 await journal.prepare({
  id,ownerKind:'digital-operation',ownerId,
  operation:'cancel-team-mission',targetId:missionId
 });
 await journal.confirm(id);
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

test('cross-instance cancellation cannot be resurrected by an older delayed start',async t=>{
 const base=await setup(t);
 let started!:()=>void,finish!:()=>void;
 const entered=new Promise<void>(resolve=>{started=resolve});
 const gate=new Promise<void>(resolve=>{finish=resolve});
 let underlying='PENDING';
 const teams={
   submit:async (input:{missionId:string})=>({id:input.missionId,state:'PENDING'}),
   inspect:async(id:string)=>({id,state:underlying}),
   start:async(id:string)=>{started();await gate;underlying='RUNNING';return {id,state:'RUNNING'}},
   cancel:async(id:string)=>{underlying='CANCELLED';return {id,state:'CANCELLED'}}
 };
 const first=new DigitalOperationsLayer(base.state,{...base,teams:teams as any});
 const second=new DigitalOperationsLayer(base.state,{...base,teams:teams as any});
 const op=await first.submit({
   requestId:crypto.randomUUID(),objective:'Race-safe operation lifecycle',
   scopeKey:'project:lifecycle-race',successConditions:['cancel dominates start'],
   execution:{kind:'team',workItems:work()},run:false
 });
 const start=first.start(op.id);
 await entered;
 const cancel=second.cancel(op.id);
 await new Promise(resolve=>setTimeout(resolve,100));
 finish();
 await Promise.all([start,cancel]);
 assert.equal((await first.inspect(op.id)).state,'CANCELLED');
});

test('parent lifecycle refuses unconfirmed child start, pause and cancel results',async t=>{
 const base=await setup(t);
 const teams={
   submit:async(input:{missionId:string})=>({id:input.missionId,state:'PENDING'}),
   inspect:async(id:string)=>({id,state:'PENDING'}),
   start:async(id:string)=>({id,state:'BLOCKED'}),
   pause:async(id:string)=>({id,state:'RUNNING'}),
   cancel:async(id:string)=>({id,state:'VERIFIED'})
 };
 const ops=new DigitalOperationsLayer(base.state,{...base,teams:teams as any});
 const op=await ops.submit({requestId:crypto.randomUUID(),
   objective:'Confirm external child outcome',scopeKey:'project:confirm-child',
   successConditions:['never claim false child state'],
   execution:{kind:'team',workItems:work()},run:false
 });
 await assert.rejects(ops.start(op.id),(e:any)=>e?.code==='OPERATIONS_CHILD_START_UNCONFIRMED');
 await assert.rejects(ops.pause(op.id),(e:any)=>e?.code==='OPERATIONS_CHILD_PAUSE_UNCONFIRMED');
 await assert.rejects(ops.cancel(op.id),(e:any)=>e?.code==='OPERATIONS_CHILD_CANCEL_UNCONFIRMED');
 assert.equal((await ops.inspect(op.id)).state,'PENDING');
});

test('terminal operation retains device reconciliation when release is unconfirmed', async t => {
  const base = await setup(t);
  let releases = 0;
  const devices = {
    async reserve(_request:unknown,_ads:unknown[],opts:{reservationId:string}){
      return {id:opts.reservationId,sessionId:crypto.randomUUID(),state:'ACTIVE'};
    },
    async release(id:string){ releases++; return {id,state:'ACTIVE'}; }
  };
  const ops = new DigitalOperationsLayer(base.state,{...base,devices:devices as any});
  const op = await ops.submit({
    requestId:crypto.randomUUID(),objective:'Verify actual device release',
    scopeKey:'project:device-release',successConditions:['confirmed scheduler release'],
    execution:{kind:'team',workItems:work()},run:false,
    device:{request:{workloadKey:'work:release-confirm'},advertisements:[]}
  });
  const result = await ops.cancel(op.id);
  assert.equal(result.state,'CANCELLED');
  assert.equal(releases,1);
  assert.equal(result.deviceReservationStatus,'reconciliation_required');
  assert.equal(result.deviceReservationErrorCode,'DEVICE_RESERVATION_RELEASE_UNCONFIRMED');
});

test('recovery of a foreign child mission and reservation is quarantined without external effects',async t=>{
 const base=await setup(t);
 const ownerId=crypto.randomUUID();
 const unrelated=await base.teams.submit({missionId:crypto.randomUUID(),objective:'Foreign mission',workItems:work()});
 await base.teams.start(unrelated.id);
 let releaseCalls=0;
 const devices={async release(){releaseCalls++;return {state:'RELEASED'};}};
 const journal=new DurableCompensationJournal(base.state);
 await journal.prepare({id:crypto.randomUUID(),ownerKind:'digital-operation',ownerId,
   operation:'cancel-team-mission',targetId:unrelated.id});
 await journal.prepare({id:crypto.randomUUID(),ownerKind:'digital-operation',ownerId,
   operation:'release-device-reservation',targetId:crypto.randomUUID()});
 const layer=new DigitalOperationsLayer(base.state,{...base,devices:devices as any});
 assert.deepEqual(await layer.recoverPendingCompensations(),{recovered:0,pending:2});
 assert.equal((await base.teams.inspect(unrelated.id)).state,'RUNNING');
 assert.equal(releaseCalls,0);
});

test('purpose separation prevents recycling a reserved mission ID as device release authority',async t=>{
 const base=await setup(t);
 const ownerId=crypto.randomUUID();
 const missionId=digitalOperationChildId(ownerId,'cancel-team-mission');
 const deviceId=digitalOperationChildId(ownerId,'release-device-reservation');
 assert.notEqual(missionId,deviceId);
 let releases=0;
 const journal=new DurableCompensationJournal(base.state);
 await journal.prepare({id:crypto.randomUUID(),ownerKind:'digital-operation',ownerId,
  operation:'release-device-reservation',targetId:missionId});
 const layer=new DigitalOperationsLayer(base.state,{...base,devices:{async release(){releases++;return {state:'RELEASED'};}} as any});
 assert.deepEqual(await layer.recoverPendingCompensations(),{recovered:0,pending:1});
 assert.equal(releases,0);
});

test('provider-supplied foreign reservation ID is quarantined and never released', async t=>{
 const base=await setup(t);
 const requestId=crypto.randomUUID();
 const expected=digitalOperationChildId(requestId,'release-device-reservation');
 const foreign=crypto.randomUUID();
 const released:string[]=[];
 const devices={
  async reserve(){return {id:foreign,sessionId:crypto.randomUUID(),state:'ACTIVE'};},
  async release(id:string){released.push(id);return {id,state:'RELEASED'};}
 };
 const journal=new DurableCompensationJournal(base.state);
 const layer=new DigitalOperationsLayer(base.state,{...base,devices:devices as any,compensations:journal});
 await assert.rejects(layer.submit({
  requestId,objective:'Reject forged reservation acknowledgement',
  scopeKey:'project:foreign-reservation',successConditions:['no foreign cleanup'],
  execution:{kind:'team',workItems:work()},
  device:{request:{workloadKey:'foreign-reservation'},advertisements:[]}
 }),(error:any)=>error?.code==='COMPENSATION_BLOCKED' && error?.details?.reserveCode==='DEVICE_POOL_RESERVATION_ID_CONFLICT');
 assert.ok(released.every(id=>id===expected),'foreign provider ID must never be released');
 assert.ok(!released.includes(foreign));
 const pending=await journal.pending('digital-operation');
 assert.equal(pending.length,3);
 assert.ok(pending.some(item=>item.operation==='reconcile-untrusted-device-reservation' && item.targetId===foreign));
 assert.ok(pending.some(item=>item.operation==='reconcile-unacknowledged-device-reservation'));
 assert.deepEqual(await layer.recoverPendingCompensations(),{recovered:0,pending:3});
});

test('provider-supplied foreign team mission ID is never cancelled by an operation',async t=>{
 const base=await setup(t);
 const foreign=crypto.randomUUID();
 const cancelled:string[]=[];
 const team={
  async submit(){return {id:foreign};},
  async cancel(id:string){cancelled.push(id);return {id,state:'CANCELLED'};}
 };
 const journal=new DurableCompensationJournal(base.state);
 const layer=new DigitalOperationsLayer(base.state,{...base,teams:team as any,compensations:journal});
 const requestId=crypto.randomUUID();
 await assert.rejects(layer.submit({
  requestId,objective:'Reject forged mission acknowledgement',
  scopeKey:'project:foreign-team',successConditions:['no foreign cancellation'],
  execution:{kind:'team',workItems:work()}
 }),(error:any)=>error?.code==='COMPENSATION_BLOCKED');
 assert.ok(!cancelled.includes(foreign));
 assert.ok(cancelled.every(id=>id===digitalOperationChildId(requestId,'cancel-team-mission')));
 const pending=await journal.pending('digital-operation');
 assert.equal(pending.length,3);
 assert.ok(pending.some(item=>item.operation==='reconcile-untrusted-team-mission' && item.targetId===foreign));
 assert.ok(pending.some(item=>item.operation==='reconcile-unacknowledged-team-mission'));
});

test('preexisting reserved mission identity never authorizes cancellation of unrelated work',async t=>{
 const base=await setup(t);
 const requestId=crypto.randomUUID();
 const collisionId=digitalOperationChildId(requestId,'cancel-team-mission');
 const unrelated=await base.teams.submit({missionId:collisionId,objective:'Unrelated preexisting work',workItems:work()});
 await base.teams.start(unrelated.id);
 const journal=new DurableCompensationJournal(base.state);
 const layer=new DigitalOperationsLayer(base.state,{...base,compensations:journal});
 await assert.rejects(layer.submit({requestId,objective:'New colliding operation',
  scopeKey:'project:collision',successConditions:['no unrelated cancellation'],
  execution:{kind:'team',workItems:work()}
 }),(error:any)=>error?.code==='COMPENSATION_BLOCKED');
 assert.equal((await base.teams.inspect(collisionId)).state,'RUNNING');
 const pending=await journal.pending('digital-operation');
 assert.ok(pending.some(item=>item.operation==='cancel-team-mission' && !item.confirmedAt));
 assert.ok(pending.some(item=>item.operation==='reconcile-unacknowledged-team-mission'));
 assert.deepEqual(await layer.recoverPendingCompensations(),{recovered:0,pending:2});
 assert.equal((await base.teams.inspect(collisionId)).state,'RUNNING');
});


test('confirmed orphan child NOT_FOUND stays quarantined until exact cancellation is proved', async (t) => {
  const base = await setup(t);
  const ownerId = crypto.randomUUID();
  const missionId = digitalOperationChildId(ownerId, 'cancel-team-mission');
  const journal = new DurableCompensationJournal(base.state);
  const intent = await journal.prepare({
    id: crypto.randomUUID(), ownerKind: 'digital-operation', ownerId,
    operation: 'cancel-team-mission', targetId: missionId
  });
  await journal.confirm(intent.id);
  let known = false, cancels = 0;
  const teams = {
    async cancel(id: string) {
      assert.equal(id, missionId);
      cancels++;
      if (!known) throw Object.assign(new Error('temporarily unseen child'), { code: 'TEAM_NOT_FOUND' });
      return { id, state: 'CANCELLED' };
    }
  };
  const restarted = new DigitalOperationsLayer(base.state, {
    ...base, teams: teams as any, compensations: new DurableCompensationJournal(base.state)
  });
  assert.deepEqual(await restarted.recoverPendingCompensations(), { recovered: 0, pending: 1 });
  assert.equal((await journal.pending('digital-operation'))[0]?.id, intent.id);
  known = true;
  assert.deepEqual(await restarted.recoverPendingCompensations(), { recovered: 1, pending: 0 });
  assert.equal(cancels, 2);
});


test('write-ahead allocation survives lost provider response: durable exact proof releases only its reservation', async (t) => {
  const { state, devices } = await setup(t);
  const registry = new DeviceRegistryStore(state);
  const principal = await new DeviceIdentityStore(await tempDir(t), { platform: 'linux' }).loadOrCreate('provenance-test-device');
  await registry.registerVerifiedPeer(principal);
  const operationId = crypto.randomUUID();
  const reservationId = digitalOperationChildId(operationId, 'release-device-reservation');
  const request = { workloadKey: 'reservation-crash-evidence', slots: 1 };
  const digest = devicePoolAllocationRequestDigest(request);
  const journal = new DurableCompensationJournal(state);
  const intentId = crypto.randomUUID();
  const quarantineId = crypto.randomUUID();
  await journal.prepare({ id: intentId, ownerKind: 'digital-operation', ownerId: operationId,
    operation: 'release-device-reservation', targetId: reservationId, allocationRequestDigest: digest });
  // This provider write commits, but the caller crashes before confirm(intent).
  await devices.reserve(request, [{
    deviceId: principal.deviceId, sessionId: crypto.randomUUID(), capabilities: [],
    observedAt: new Date().toISOString(), cpuSlots: 8, memoryMb: 8192, gpu: false,
    tags: [], activeJobs: 0, maxConcurrentJobs: 1
  }], { reservationId });
  await journal.prepare({ id: quarantineId, ownerKind: 'digital-operation', ownerId: operationId,
    operation: 'reconcile-unacknowledged-device-reservation', targetId: reservationId });
  const restarted = new DigitalOperationsLayer(state, {
    procedures: new ProcedureMemoryStore(state), world: new WorldModelStore(state),
    devices: new DevicePoolScheduler(state, registry, new DeviceRoutingStore(state, registry)),
    optimizer: new ExecutionOptimizerStore(state), teams: new TeamCoordinator(state),
    organizations: new OrganizationCoordinator(state, new TeamCoordinator(state)),
    availableCapabilities: ['file.read']
  });
  const recovery = await restarted.recoverPendingCompensations();
  assert.equal(recovery.pending, 0);
  assert.ok(recovery.recovered >= 1);
  assert.equal((await devices.inspectPrepared(reservationId, digest))?.state, 'RELEASED');
  assert.deepEqual(await journal.pending('digital-operation'), []);
});

test('unbound request proofs and unavailable provider observations never grant reservation release', async (t) => {
  const { state, ops, devices } = await setup(t);
  const registry = new DeviceRegistryStore(state);
  const principal = await new DeviceIdentityStore(await tempDir(t), { platform: 'linux' }).loadOrCreate('untrusted-reservation-device');
  await registry.registerVerifiedPeer(principal);
  const opId = crypto.randomUUID();
  const reservationId = digitalOperationChildId(opId, 'release-device-reservation');
  const req = { workloadKey: 'legitimate-reservation' };
  const realDigest = devicePoolAllocationRequestDigest(req);
  const journal = new DurableCompensationJournal(state);
  await journal.prepare({ id: crypto.randomUUID(), ownerKind: 'digital-operation', ownerId: opId,
    operation: 'release-device-reservation', targetId: reservationId,
    allocationRequestDigest: devicePoolAllocationRequestDigest({workloadKey:'different-workload'}) });
  await devices.reserve(req, [{
    deviceId: principal.deviceId, sessionId: crypto.randomUUID(), capabilities: [],
    observedAt: new Date().toISOString(), cpuSlots: 8, memoryMb: 8192, gpu: false,
    tags: [], activeJobs: 0, maxConcurrentJobs: 1
  }], { reservationId });
  await assert.rejects(devices.inspectPrepared(reservationId, 'f'.repeat(64)),
    (e: any) => e?.code === 'DEVICE_POOL_ALLOCATION_PROOF_MISMATCH');
  const outcome = await ops.recoverPendingCompensations();
  assert.equal(outcome.recovered, 0);
  assert.equal(outcome.pending, 1);
  assert.equal((await devices.inspectPrepared(reservationId, realDigest))?.state, 'ACTIVE');
  assert.equal(await devices.inspectPrepared(crypto.randomUUID(), realDigest), null);
});

test('atomic prepared reservation release rejects foreign proof without changing provider state', async (t) => {
  const { state, devices } = await setup(t);
  const registry = new DeviceRegistryStore(state);
  const peer = await new DeviceIdentityStore(await tempDir(t), { platform: 'linux' }).loadOrCreate('atomic-reservation-device');
  await registry.registerVerifiedPeer(peer);
  const request = { workloadKey: 'authentic-reservation' };
  const proof = devicePoolAllocationRequestDigest(request);
  const id = crypto.randomUUID();
  await devices.reserve(request, [{
    deviceId: peer.deviceId, sessionId: crypto.randomUUID(), capabilities: [],
    observedAt: new Date().toISOString(), cpuSlots: 8, memoryMb: 8192,
    gpu: false, tags: [], activeJobs: 0, maxConcurrentJobs: 1
  }], { reservationId: id });
  const foreign = devicePoolAllocationRequestDigest({ workloadKey: 'foreign-identity' });
  await assert.rejects(devices.releasePrepared(id, foreign),
    (e: any) => e?.code === 'DEVICE_POOL_ALLOCATION_PROOF_MISMATCH');
  assert.equal((await devices.inspectPrepared(id, proof))?.state, 'ACTIVE');
  const separatelyConnected = new DevicePoolScheduler(state, registry, new DeviceRoutingStore(state, registry));
  const competing = await Promise.allSettled([
    separatelyConnected.releasePrepared(id, foreign),
    devices.releasePrepared(id, proof)
  ]);
  assert.equal(competing.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(competing.filter(x => x.status === 'rejected').length, 1);
  assert.equal((competing.find((x): x is PromiseRejectedResult => x.status === 'rejected')?.reason as any)?.code,
    'DEVICE_POOL_ALLOCATION_PROOF_MISMATCH');
  assert.equal((await devices.inspectPrepared(id, proof))?.state, 'RELEASED');
  assert.equal((await separatelyConnected.releasePrepared(id, proof))?.state, 'RELEASED');
  assert.equal(await devices.releasePrepared(crypto.randomUUID(), proof), null);
});

test('confirmed recovery also retains ownership when stored allocation request differs', async (t) => {
  const { state, ops, devices } = await setup(t);
  const registry = new DeviceRegistryStore(state);
  const peer = await new DeviceIdentityStore(await tempDir(t), { platform: 'linux' }).loadOrCreate('confirmed-foreign-reservation');
  await registry.registerVerifiedPeer(peer);
  const ownerId = crypto.randomUUID();
  const reservationId = digitalOperationChildId(ownerId, 'release-device-reservation');
  const actual = { workloadKey: 'owner-request' };
  const journal = new DurableCompensationJournal(state);
  const intent = await journal.prepare({
    id: crypto.randomUUID(), ownerKind: 'digital-operation', ownerId,
    operation: 'release-device-reservation', targetId: reservationId,
    allocationRequestDigest: devicePoolAllocationRequestDigest({ workloadKey: 'not-this-owner' })
  });
  await journal.confirm(intent.id);
  await devices.reserve(actual, [{
    deviceId: peer.deviceId, sessionId: crypto.randomUUID(), capabilities: [],
    observedAt: new Date().toISOString(), cpuSlots: 8, memoryMb: 8192,
    gpu: false, tags: [], activeJobs: 0, maxConcurrentJobs: 1
  }], { reservationId });
  const recovered = await ops.recoverPendingCompensations();
  assert.equal(recovered.recovered, 0);
  assert.equal(recovered.pending, 1);
  assert.equal((await devices.inspectPrepared(reservationId, devicePoolAllocationRequestDigest(actual)))?.state, 'ACTIVE');
  assert.ok((await journal.pending('digital-operation')).some(entry => entry.id === intent.id));
});

test('immediate failure never retires acknowledged child intent on NOT_FOUND response', async t => {
  const base = await setup(t);
  let missionId = '';
  const teams = {
    async submit(input: { missionId: string }) {
      missionId = input.missionId;
      return { id: missionId };
    },
    async start() { throw new Error('start transport failed'); },
    async cancel(id: string) {
      assert.equal(id, missionId);
      throw Object.assign(new Error('child not observed on this host'), { code: 'TEAM_NOT_FOUND' });
    }
  };
  const journal = new DurableCompensationJournal(base.state);
  const ops = new DigitalOperationsLayer(base.state, {
    ...base, teams: teams as any, compensations: journal
  });
  await assert.rejects(ops.submit({
    objective: 'Crash-safe child compensation', scopeKey: 'project:child-proof',
    successConditions: ['no lost owned mission'],
    execution: { kind: 'team', workItems: work() }, run: true
  }), (e: any) => e?.code === 'COMPENSATION_BLOCKED' &&
    e?.details?.failed?.includes('cancel-team-mission'));
  const pending = await journal.pending('digital-operation');
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.operation, 'cancel-team-mission');
  assert.equal(pending[0]!.targetId, missionId);
  assert.ok(pending[0]!.confirmedAt, 'child creation was explicitly acknowledged');
  assert.deepEqual(await ops.list(), []);
});

test('immediate rollback uses exact proof-bound reservation release and retains intent on foreign receipt', async t => {
  const base = await setup(t);
  let reservationId = '';
  let ordinaryReleaseCalls = 0;
  let preparedCalls = 0;
  const request = { workloadKey: 'proof-bound:rollback' };
  const expectedDigest = devicePoolAllocationRequestDigest(request);
  const devices = {
    async reserve(_request: unknown, _advertisements: unknown, options: { reservationId: string }) {
      reservationId = options.reservationId;
      return { id: reservationId, sessionId: crypto.randomUUID(), state: 'ACTIVE' };
    },
    async release() {
      ordinaryReleaseCalls++;
      throw new Error('unfenced release must never run');
    },
    async releasePrepared(id: string, digest: string) {
      preparedCalls++;
      assert.equal(id, reservationId);
      assert.equal(digest, expectedDigest);
      return { id: crypto.randomUUID(), state: 'RELEASED' };
    }
  };
  const teams = {
    async submit(input: { missionId: string }) { return { id: input.missionId }; },
    async start() { throw new Error('start failed after reservation'); },
    async cancel(id: string) { return { id, state: 'CANCELLED' }; }
  };
  const journal = new DurableCompensationJournal(base.state);
  const ops = new DigitalOperationsLayer(base.state, {
    ...base, devices: devices as any, teams: teams as any, compensations: journal
  });
  await assert.rejects(ops.submit({
    objective: 'Exact reservation release', scopeKey: 'project:reservation-proof',
    successConditions: ['only owned reservation released'],
    execution: { kind: 'team', workItems: work() }, run: true,
    device: { request, advertisements: [] }
  }), (e: any) => e?.code === 'COMPENSATION_BLOCKED' &&
    e?.details?.failed?.includes('release-device-reservation'));
  assert.equal(preparedCalls, 1);
  assert.equal(ordinaryReleaseCalls, 0);
  const pending = await journal.pending('digital-operation');
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.operation, 'release-device-reservation');
  assert.equal(pending[0]!.targetId, reservationId);
  assert.equal(pending[0]!.allocationRequestDigest, expectedDigest);
  assert.ok(pending[0]!.confirmedAt);
});

test('confirmed restart cleanup requires exact child identity and bound reservation terminal receipt', async t => {
  const base = await setup(t);
  const ownerId = crypto.randomUUID();
  const journal = new DurableCompensationJournal(base.state);
  const request = { workloadKey: 'external-confirmed:recovery' };
  const digest = devicePoolAllocationRequestDigest(request);
  const teamId = digitalOperationChildId(ownerId, 'cancel-team-mission');
  const organizationId = digitalOperationChildId(ownerId, 'cancel-organization-program');
  const reservationId = digitalOperationChildId(ownerId, 'release-device-reservation');
  for (const [operation, targetId] of [
    ['cancel-team-mission', teamId],
    ['cancel-organization-program', organizationId],
    ['release-device-reservation', reservationId]
  ]) {
    const intent = await journal.prepare({
      id: crypto.randomUUID(), ownerKind: 'digital-operation', ownerId, operation, targetId,
      ...(operation === 'release-device-reservation' ? { allocationRequestDigest: digest } : {})
    });
    await journal.confirm(intent.id);
  }
  let legacyCalls = 0;
  const teams = { async cancel(id: string) {
    assert.equal(id, teamId);
    return { id: crypto.randomUUID(), state:'CANCELLED' };
  }};
  const organizations = { async cancel(id: string) {
    assert.equal(id, organizationId);
    return { id: crypto.randomUUID(), state:'CANCELLED' };
  }};
  const devices = {
    async release() { legacyCalls++; throw new Error('unbound release forbidden'); },
    async releasePrepared(id: string, observedDigest: string) {
      assert.equal(id, reservationId);
      assert.equal(observedDigest, digest);
      return { id: crypto.randomUUID(), state:'RELEASED' };
    }
  };
  const ops = new DigitalOperationsLayer(base.state, {
    ...base, teams: teams as any, organizations: organizations as any,
    devices: devices as any, compensations: journal
  });
  assert.deepEqual(await ops.recoverPendingCompensations(), { recovered:0, pending:3 });
  assert.equal(legacyCalls, 0);
  assert.equal((await journal.pending('digital-operation')).length, 3);
});

test('pre-digest legacy confirmed reservation cannot use naked ID release during restart recovery', async t => {
  const base = await setup(t);
  const journal = new DurableCompensationJournal(base.state);
  const ownerId = crypto.randomUUID();
  const reservationId = digitalOperationChildId(ownerId, 'release-device-reservation');
  const prepared = await journal.prepare({
    id: crypto.randomUUID(), ownerKind:'digital-operation', ownerId,
    operation:'release-device-reservation', targetId:reservationId
  });
  await journal.confirm(prepared.id);
  let releaseCalls = 0;
  const devices = {
    async release() { releaseCalls++; return { id:reservationId, state:'RELEASED' }; },
    async releasePrepared() { releaseCalls++; return { id:reservationId, state:'RELEASED' }; }
  };
  const ops = new DigitalOperationsLayer(base.state, { ...base,
    devices: devices as any, compensations: journal });
  assert.deepEqual(await ops.recoverPendingCompensations(), { recovered:0, pending:1 });
  assert.equal(releaseCalls, 0, 'unproven pre-upgrade cleanup must remain quarantined');
  assert.equal((await journal.pending('digital-operation'))[0]?.targetId, reservationId);
});

async function provisionFinalizationReservation(t: test.TestContext) {
  const base = await setup(t);
  const identity = await new DeviceIdentityStore(await tempDir(t), { platform: 'linux' }).loadOrCreate('pool-owner');
  await base.registry.registerVerifiedPeer(identity);
  const request = { workloadKey: 'audit:proof-bound-finalization' };
  const operation = await base.ops.submit({
    objective: 'Complete a proof-bound reservation workload',
    scopeKey: 'project:release-proof',
    successConditions: ['The operation is safely finalized'],
    execution: { kind: 'team', workItems: work() },
    device: {
      request,
      advertisements: [{
        deviceId: identity.deviceId,
        sessionId: crypto.randomUUID(),
        capabilities: ['file.read'],
        observedAt: new Date().toISOString(),
        cpuSlots: 4,
        memoryMb: 8192,
        gpu: false,
        tags: [],
        activeJobs: 0,
        maxConcurrentJobs: 1
      }]
    },
    run: true
  });
  assert.ok(operation.deviceReservationId);
  assert.equal(operation.deviceAllocationRequestDigest, devicePoolAllocationRequestDigest(request));
  return { base, operation };
}

test('stage10 normal finalization releases only exact proven allocation and persists its proof', async t => {
  const { base, operation } = await provisionFinalizationReservation(t);
  const id = operation.deviceReservationId!;
  const digest = operation.deviceAllocationRequestDigest!;
  assert.equal((await base.devices.inspectPrepared(id, digest))?.state, 'ACTIVE');
  const cancelled = await base.ops.cancel(operation.id);
  assert.equal(cancelled.outcomeRecorded, true);
  assert.equal(cancelled.deviceReservationStatus, 'released');
  assert.equal((await base.devices.inspectPrepared(id, digest))?.state, 'RELEASED');
});

test('stage10 normal finalization never releases a foreign reservation with reused ID', async t => {
  const { base, operation } = await provisionFinalizationReservation(t);
  const poolFile = path.join(base.state, 'device-pool.json');
  const pool = JSON.parse(await fs.readFile(poolFile, 'utf8'));
  const reservation = pool.reservations.find((r: any) => r.id === operation.deviceReservationId);
  assert.ok(reservation);
  reservation.allocationRequestDigest = 'f'.repeat(64);
  assert.notEqual(reservation.allocationRequestDigest, operation.deviceAllocationRequestDigest);
  await fs.writeFile(poolFile, JSON.stringify(pool, null, 2));

  const cancelled = await base.ops.cancel(operation.id);
  assert.equal(cancelled.outcomeRecorded, true);
  assert.equal(cancelled.deviceReservationStatus, 'reconciliation_required');
  assert.equal(cancelled.deviceReservationErrorCode, 'DEVICE_POOL_ALLOCATION_PROOF_MISMATCH');
  assert.equal((await base.devices.list({ activeOnly: true }))[0]?.id, operation.deviceReservationId);
});

test('stage10 legacy operation without allocation digest cannot release a reservation by ID alone', async t => {
  const { base, operation } = await provisionFinalizationReservation(t);
  const opsFile = path.join(base.state, 'digital-operations.json');
  const state = JSON.parse(await fs.readFile(opsFile, 'utf8'));
  const persisted = state.operations.find((o: any) => o.id === operation.id);
  assert.ok(persisted);
  delete persisted.deviceAllocationRequestDigest;
  await fs.writeFile(opsFile, JSON.stringify(state, null, 2));

  const cancelled = await base.ops.cancel(operation.id);
  assert.equal(cancelled.deviceReservationStatus, 'reconciliation_required');
  assert.equal(cancelled.deviceReservationErrorCode, 'DEVICE_RESERVATION_PROOF_MISSING');
  assert.equal((await base.devices.list({ activeOnly: true }))[0]?.id, operation.deviceReservationId);
});

test('stage10 persisted allocation proofs reject coerced digest values', async t => {
  const { base, operation } = await provisionFinalizationReservation(t);
  const opsFile = path.join(base.state, 'digital-operations.json');
  const state = JSON.parse(await fs.readFile(opsFile, 'utf8'));
  const persisted = state.operations.find((o: any) => o.id === operation.id);
  assert.ok(persisted);
  persisted.deviceAllocationRequestDigest = ['f'.repeat(64)];
  await fs.writeFile(opsFile, JSON.stringify(state, null, 2));
  await assert.rejects(
    () => base.ops.inspect(operation.id),
    (error: any) => error?.code === 'OPERATIONS_STATE_CORRUPT'
  );
});
