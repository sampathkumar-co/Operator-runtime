import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TeamCoordinator, type TeamWorkInput } from '../src/core/team-coordinator.ts';
import { OrganizationCoordinator } from '../src/core/organization-coordinator.ts';
import { DurableCompensationJournal } from '../src/core/compensation-journal.ts';
import { OperatorError } from '../src/core/errors.ts';

async function tempDir(t: test.TestContext): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-org-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function work(target: string): TeamWorkInput[] {
  return [
    { key: 'change', title: 'Change ' + target, role: 'general', risk: 'read' },
    { key: 'verify', title: 'Verify ' + target, role: 'verifier', risk: 'read', dependsOn: ['change'] }
  ];
}

async function finishMission(teams: TeamCoordinator, missionId: string): Promise<void> {
  const worker = (await teams.registerWorker(missionId, { role: 'general', label: 'worker' })).worker;
  const verifier = (await teams.registerWorker(missionId, { role: 'verifier', label: 'verifier' })).worker;
  const first = await teams.claim(missionId, { workerId: worker.id });
  await teams.complete(missionId, {
    workerId: worker.id, workItemId: first.workItem!.id, leaseId: first.workItem!.lease!.id,
    summary: 'complete'
  });
  const verification = await teams.claim(missionId, { workerId: verifier.id });
  await teams.complete(missionId, {
    workerId: verifier.id, workItemId: verification.workItem!.id, leaseId: verification.workItem!.lease!.id,
    summary: 'verified', verificationPassed: true,
    evidence: [{ kind: 'verification', status: 'pass', message: 'verified' }]
  });
}

test('stage8 starts only canary wave and requires verified promotion before increasing blast radius', async (t) => {
  const state = await tempDir(t);
  const teams = new TeamCoordinator(state);
  const org = new OrganizationCoordinator(state, teams);
  const program = await org.create({
    objective: 'Upgrade services',
    policy: { canarySize: 1, waveSize: 2, maxParallel: 2, allowedScopePrefixes: ['org:acme'] },
    targets: [
      { key: 'svc-a', scopeKey: 'org:acme:svc-a', workItems: work('a') },
      { key: 'svc-b', scopeKey: 'org:acme:svc-b', workItems: work('b') },
      { key: 'svc-c', scopeKey: 'org:acme:svc-c', workItems: work('c') }
    ]
  });
  const started = await org.start(program.id);
  assert.equal(started.waves[0]?.state, 'RUNNING');
  assert.ok(started.targets[0]?.missionId);
  assert.equal(started.targets[1]?.missionId, undefined);
  assert.equal(started.targets[2]?.missionId, undefined);

  await finishMission(teams, started.targets[0]!.missionId!);
  const refreshed = await org.refresh(program.id);
  assert.equal(refreshed.waves[0]?.state, 'VERIFIED');
  assert.match(refreshed.waves[0]?.verificationDigest ?? '', /^[0-9a-f]{64}$/);
  assert.equal(refreshed.state, 'PAUSED');
  assert.equal(refreshed.targets[1]?.missionId, undefined);
  await assert.rejects(
    () => org.promote(program.id, 'a'.repeat(64)),
    (error: any) => error?.code === 'ORGANIZATION_VERIFICATION_DIGEST_MISMATCH'
  );

  const promoted = await org.promote(program.id, refreshed.waves[0]!.verificationDigest!);
  assert.equal(promoted.activeWave, 1);
  assert.equal(promoted.waves[1]?.state, 'RUNNING');
  assert.ok(promoted.targets[1]?.missionId);
  assert.ok(promoted.targets[2]?.missionId);
});

test('stage8 final program requires every wave verification and explicit promotion digest', async (t) => {
  const state = await tempDir(t);
  const teams = new TeamCoordinator(state);
  const org = new OrganizationCoordinator(state, teams);
  const program = await org.create({
    objective: 'Rollout',
    policy: { canarySize: 1, waveSize: 1, maxParallel: 1, allowedScopePrefixes: ['org:x'] },
    targets: [
      { key: 'one', scopeKey: 'org:x:one', workItems: work('one') },
      { key: 'two', scopeKey: 'org:x:two', workItems: work('two') }
    ]
  });
  let current = await org.start(program.id);
  await finishMission(teams, current.targets[0]!.missionId!);
  current = await org.refresh(program.id);
  await assert.rejects(org.promote(program.id, 'bad'), /SHA-256/);
  await assert.rejects(
    () => org.promote(program.id, 'b'.repeat(64)),
    (error: any) => error?.code === 'ORGANIZATION_VERIFICATION_DIGEST_MISMATCH'
  );
  current = await org.promote(program.id, current.waves[0]!.verificationDigest!);
  await finishMission(teams, current.targets[1]!.missionId!);
  current = await org.refresh(program.id);
  assert.equal(current.state, 'PAUSED');
  current = await org.promote(program.id, current.waves[1]!.verificationDigest!);
  assert.equal(current.state, 'VERIFIED');
});

test('stage8 fails closed when a canary mission fails and never starts later waves', async (t) => {
  const state = await tempDir(t);
  const teams = new TeamCoordinator(state);
  const org = new OrganizationCoordinator(state, teams);
  const program = await org.create({
    objective: 'Risky rollout',
    policy: { canarySize: 1, waveSize: 1, maxParallel: 1, allowedScopePrefixes: ['org:r'] },
    targets: [
      { key: 'canary', scopeKey: 'org:r:canary', workItems: work('canary') },
      { key: 'later', scopeKey: 'org:r:later', workItems: work('later') }
    ]
  });
  const started = await org.start(program.id);
  const missionId = started.targets[0]!.missionId!;
  const worker = (await teams.registerWorker(missionId, { role: 'general', label: 'worker' })).worker;
  const claim = await teams.claim(missionId, { workerId: worker.id });
  await teams.fail(missionId, {
    workerId: worker.id, workItemId: claim.workItem!.id, leaseId: claim.workItem!.lease!.id,
    code: 'TEST_FAILURE', message: 'failed', sideEffectState: 'none', retryable: false
  });
  const refreshed = await org.refresh(program.id);
  assert.equal(refreshed.state, 'FAILED');
  assert.equal(refreshed.waves[0]?.state, 'FAILED');
  assert.equal(refreshed.targets[1]?.missionId, undefined);
});

test('stage8 rejects targets outside explicit organization scope prefixes', async (t) => {
  const state = await tempDir(t);
  const org = new OrganizationCoordinator(state, new TeamCoordinator(state));
  await assert.rejects(
    org.create({
      objective: 'No scope escape',
      policy: { allowedScopePrefixes: ['org:allowed'] },
      targets: [{ key: 'bad', scopeKey: 'org:other:svc', workItems: work('bad') }]
    }),
    (error: any) => error?.code === 'ORGANIZATION_SCOPE_DENIED'
  );
});

test('stage8 bounded retention reclaims only the oldest terminal program beyond 500 entries', async (t) => {
  const state = await tempDir(t);
  const org = new OrganizationCoordinator(state, new TeamCoordinator(state));
  const seed = await org.create({
    objective: 'retention seed',
    policy: { allowedScopePrefixes: ['org:test'] },
    targets: [{ key: 'seed', scopeKey: 'org:test:seed', workItems: work('seed') }]
  });
  const file = path.join(state, 'organization-programs.json');
  const persisted = JSON.parse(await fs.readFile(file, 'utf8')) as any;
  const oldestId = crypto.randomUUID();
  persisted.programs = Array.from({ length: 500 }, (_, index) => ({
    ...structuredClone(seed),
    id: index === 0 ? oldestId : crypto.randomUUID(),
    objective: `terminal-${index}`,
    state: 'VERIFIED',
    createdAt: new Date(index * 1000).toISOString(),
    updatedAt: new Date(index * 1000).toISOString()
  }));
  await fs.writeFile(file, JSON.stringify(persisted));

  const created = await new OrganizationCoordinator(state, new TeamCoordinator(state)).create({
    objective: 'new after terminal retention',
    policy: { allowedScopePrefixes: ['org:test'] },
    targets: [{ key: 'new', scopeKey: 'org:test:new', workItems: work('new') }]
  });
  const after = JSON.parse(await fs.readFile(file, 'utf8')) as any;
  assert.equal(after.programs.length, 500);
  assert.equal(after.programs.some((item: any) => item.id === oldestId), false);
  assert.equal(after.programs.some((item: any) => item.id === created.id), true);

  after.programs = after.programs.map((item: any) => ({ ...item, state: 'PENDING' }));
  await fs.writeFile(file, JSON.stringify(after));
  await assert.rejects(
    () => new OrganizationCoordinator(state, new TeamCoordinator(state)).create({
      objective: 'must not evict active',
      policy: { allowedScopePrefixes: ['org:test'] },
      targets: [{ key: 'blocked', scopeKey: 'org:test:blocked', workItems: work('blocked') }]
    }),
    (error: any) => error?.code === 'ORGANIZATION_PROGRAM_LIMIT'
  );
});


test('stage8 compensates already-created missions when a later wave target fails to start', async (t) => {
  const state = await tempDir(t);
  const created: string[] = [];
  const cancelled: string[] = [];
  let submits = 0;
  const fakeTeams = {
    async submit(input: { missionId: string }) {
      submits += 1;
      if (submits === 2) throw new Error('simulated second target creation failure');
      created.push(input.missionId);
      return { id: input.missionId };
    },
    async start(id: string) { return { id, state: 'RUNNING' }; },
    async cancel(id: string) { cancelled.push(id); return { id, state: 'CANCELLED' }; }
  };
  const org = new OrganizationCoordinator(state, fakeTeams as any);
  const program = await org.create({
    objective: 'Atomic rollout start',
    policy: { canarySize: 2, waveSize: 2, maxParallel: 2, allowedScopePrefixes: ['org:atomic'] },
    targets: [
      { key: 'one', scopeKey: 'org:atomic:one', workItems: work('one') },
      { key: 'two', scopeKey: 'org:atomic:two', workItems: work('two') }
    ]
  });

  await assert.rejects(org.start(program.id), /second target creation failure/);
  assert.deepEqual(cancelled, created);
  const persisted = await org.inspect(program.id);
  assert.equal(persisted.state, 'PENDING');
  assert.equal(persisted.waves[0]?.state, 'PENDING');
  assert.ok(persisted.targets.every((target) => target.missionId === undefined && target.state === 'PENDING'));
});

test('stage8 child cancel failure keeps target live and program non-terminal across restart', async (t) => {
  const state = await tempDir(t);
  let failCancel = true;
  const missions = new Map<string, string>();
  const fakeTeams = {
    async submit(input: { missionId: string }) { missions.set(input.missionId, 'PENDING'); return { id: input.missionId }; },
    async start(id: string) { missions.set(id, 'RUNNING'); return { id, state: 'RUNNING' }; },
    async cancel(id: string) {
      if (failCancel) throw Object.assign(new Error('child still running'), { code: 'TEAM_CANCEL_FAILED' });
      missions.set(id, 'CANCELLED'); return { id, state: 'CANCELLED' };
    }
  };
  const org = new OrganizationCoordinator(state, fakeTeams as any);
  const program = await org.create({
    objective: 'Truthful cancellation', policy: { allowedScopePrefixes: ['org:safe'] },
    targets: [{ key: 'one', scopeKey: 'org:safe:one', workItems: work('one') }]
  });
  await org.start(program.id);
  const blocked = await org.cancel(program.id);
  assert.equal(blocked.state, 'BLOCKED');
  assert.equal(blocked.targets[0]?.state, 'RUNNING');
  assert.equal(blocked.targets[0]?.controlFailure?.code, 'TEAM_CANCEL_FAILED');

  failCancel = false;
  const restarted = new OrganizationCoordinator(state, fakeTeams as any);
  const cancelled = await restarted.cancel(program.id);
  assert.equal(cancelled.state, 'CANCELLED');
  assert.equal(cancelled.targets[0]?.state, 'CANCELLED');
  assert.equal(cancelled.targets[0]?.controlFailure, undefined);
});

test('stage8 child pause failure keeps program blocked instead of falsely paused', async (t) => {
  const state = await tempDir(t);
  const fakeTeams = {
    async submit(input: { missionId: string }) { return { id: input.missionId }; },
    async start(id: string) { return { id, state: 'RUNNING' }; },
    async pause() { throw Object.assign(new Error('pause failed'), { code: 'TEAM_PAUSE_FAILED' }); }
  };
  const org = new OrganizationCoordinator(state, fakeTeams as any);
  const program = await org.create({
    objective: 'Truthful pause', policy: { allowedScopePrefixes: ['org:safe'] },
    targets: [{ key: 'one', scopeKey: 'org:safe:one', workItems: work('one') }]
  });
  await org.start(program.id);
  const blocked = await org.pause(program.id);
  assert.equal(blocked.state, 'BLOCKED');
  assert.equal(blocked.targets[0]?.state, 'RUNNING');
  assert.equal(blocked.targets[0]?.controlFailure?.operation, 'pause');
});


test('stage8 restart recovery cancels a child mission created before parent rollout state was committed', async (t) => {
  const state = await tempDir(t);
  const teams = new TeamCoordinator(state);
  const org = new OrganizationCoordinator(state, teams);
  const program = await org.create({
    objective: 'Crash-safe rollout',
    policy: { allowedScopePrefixes: ['org:crash'] },
    targets: [{ key: 'canary', scopeKey: 'org:crash:canary', workItems: work('canary') }]
  });

  const orphanMissionId = crypto.randomUUID();
  const orphan = await teams.submit({
    missionId: orphanMissionId,
    objective: 'Crash-safe rollout [canary]',
    workItems: work('canary')
  });
  await teams.start(orphan.id);

  const journal = new DurableCompensationJournal(state);
  await journal.prepare({
    id: `test-orphan:${program.id}`,
    ownerKind: 'organization',
    ownerId: program.id,
    operation: 'cancel-team-mission',
    targetId: orphan.id,
    subjectKey: 'canary'
  });

  const restarted = new OrganizationCoordinator(state, teams);
  const recovery = await restarted.recoverPendingCompensations();
  assert.equal(recovery.recovered, 1);
  assert.equal(recovery.pending, 0);
  assert.equal((await teams.inspect(orphan.id)).state, 'CANCELLED');

  const persisted = await restarted.inspect(program.id);
  assert.equal(persisted.state, 'PENDING');
  assert.equal(persisted.targets[0]?.missionId, undefined);
});

test('stage8 successful parent commit clears durable child compensation intent', async (t) => {
  const state = await tempDir(t);
  const teams = new TeamCoordinator(state);
  const org = new OrganizationCoordinator(state, teams);
  const program = await org.create({
    objective: 'Committed rollout',
    policy: { allowedScopePrefixes: ['org:commit'] },
    targets: [{ key: 'canary', scopeKey: 'org:commit:canary', workItems: work('canary') }]
  });
  const started = await org.start(program.id);
  assert.ok(started.targets[0]?.missionId);
  const pending = await new DurableCompensationJournal(state).pending('organization');
  assert.equal(pending.length, 0);
});

test('preassigned program identity cannot be reallocated to a second organization rollout', async (t) => {
  const state = await tempDir(t);
  const org = new OrganizationCoordinator(state, new TeamCoordinator(state));
  const programId = crypto.randomUUID();
  const input = {
    programId, objective: 'Write-ahead program identity',
    policy: { allowedScopePrefixes: ['org:identity'] },
    targets: [{ key: 'one', scopeKey: 'org:identity:one', workItems: work('one') }]
  };
  const first = await org.create(input);
  assert.equal(first.id, programId);
  await assert.rejects(org.create(input), (error: any) => error?.code === 'ORGANIZATION_PROGRAM_ID_CONFLICT');
  assert.equal((await org.list()).length, 1);
});

test('organization rollout does not trust a child mission that ignores its write-ahead ID', async (t) => {
  const state = await tempDir(t);
  const unexpectedId = crypto.randomUUID();
  let attempted = 0;
  const cancelled: string[] = [];
  const teams = {
    async submit() { attempted++; return { id: unexpectedId }; },
    async start() { throw new Error('unexpected mission must never start'); },
    async inspect(id: string) {
      if (id === unexpectedId) return { id, state: 'PENDING' };
      throw new OperatorError('TEAM_NOT_FOUND', 'Planned mission does not exist.');
    },
    async cancel(id: string) { cancelled.push(id); return { id, state: 'CANCELLED' }; }
  };
  const journal = new DurableCompensationJournal(state);
  const org = new OrganizationCoordinator(state, teams as any, { compensations: journal });
  const program = await org.create({
    objective: 'Test cross-component identity authority',
    policy: { allowedScopePrefixes: ['org:identity'] },
    targets: [{ key: 'service', scopeKey: 'org:identity:service', workItems: work('service') }]
  });

  await assert.rejects(org.start(program.id), (error: any) => error?.code === 'ORGANIZATION_MISSION_ID_CONFLICT');
  assert.equal(attempted, 1);
  assert.deepEqual(cancelled, []);
  const stored = await org.inspect(program.id);
  assert.equal(stored.state, 'PENDING');
  assert.equal(stored.targets[0]?.missionId, undefined);

  const pending = await journal.pending('organization');
  assert.equal(pending.length, 2);
  assert.ok(pending.some((intent) => intent.targetId === unexpectedId));
  assert.ok(pending.some((intent) => intent.targetId !== unexpectedId));

  const restarted = new OrganizationCoordinator(state, teams as any, {
    compensations: new DurableCompensationJournal(state)
  });
  assert.deepEqual(await restarted.recoverPendingCompensations(), { recovered: 1, pending: 1 });
  assert.deepEqual(cancelled, []);
  const quarantine = await journal.pending('organization');
  assert.equal(quarantine.length, 1);
  assert.equal(quarantine[0]?.operation, 'reconcile-untrusted-team-identity');
  assert.equal(quarantine[0]?.targetId, unexpectedId);
  await assert.rejects(restarted.start(program.id), (error: any) => error?.code === 'ORGANIZATION_RECOVERY_REQUIRED');
  assert.equal(attempted, 1);
});

test('organization recovery keeps unrollbackable verified child mission quarantined until safe cancellation proof', async (t) => {
  const state = await tempDir(t);
  let childState: 'VERIFIED' | 'RUNNING' = 'VERIFIED';
  let cancelled = 0;
  const childId = crypto.randomUUID();
  const teams = {
    async inspect(id: string) { assert.equal(id, childId); return { id, state: childState }; },
    async cancel(id: string) { assert.equal(id, childId); cancelled++; return { id, state: 'CANCELLED' }; }
  };
  const compensations = new DurableCompensationJournal(state);
  const org = new OrganizationCoordinator(state, teams as any, { compensations });
  const program = await org.create({
    objective: 'Prove truthful compensation', policy: { allowedScopePrefixes: ['org:postcondition'] },
    targets: [{ key: 'service', scopeKey: 'org:postcondition:service', workItems: work('service') }]
  });
  await compensations.prepare({
    id: crypto.randomUUID(), ownerKind: 'organization', ownerId: program.id,
    operation: 'cancel-team-mission', targetId: childId, subjectKey: 'service'
  });
  assert.deepEqual(await org.recoverPendingCompensations(), { recovered: 0, pending: 1 });
  assert.equal(cancelled, 0);
  await assert.rejects(org.start(program.id), (error: any) => error?.code === 'ORGANIZATION_RECOVERY_REQUIRED');
  childState = 'RUNNING';
  assert.deepEqual(await org.recoverPendingCompensations(), { recovered: 1, pending: 0 });
  assert.equal(cancelled, 1);
});
