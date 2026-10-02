import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TeamCoordinator, type TeamWorkInput } from '../src/core/team-coordinator.ts';
import { OrganizationCoordinator } from '../src/core/organization-coordinator.ts';

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
  assert.equal(refreshed.state, 'PAUSED');
  assert.equal(refreshed.targets[1]?.missionId, undefined);

  const promoted = await org.promote(program.id, 'a'.repeat(64));
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
  current = await org.promote(program.id, 'b'.repeat(64));
  await finishMission(teams, current.targets[1]!.missionId!);
  current = await org.refresh(program.id);
  assert.equal(current.state, 'PAUSED');
  current = await org.promote(program.id, 'c'.repeat(64));
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


test('stage8 compensates already-created missions when a later wave target fails to start', async (t) => {
  const state = await tempDir(t);
  const created: string[] = [];
  const cancelled: string[] = [];
  let submits = 0;
  const fakeTeams = {
    async submit() {
      submits += 1;
      if (submits === 2) throw new Error('simulated second target creation failure');
      const id = crypto.randomUUID();
      created.push(id);
      return { id };
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
    async submit() { const id = crypto.randomUUID(); missions.set(id, 'PENDING'); return { id }; },
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
    async submit() { return { id: crypto.randomUUID() }; },
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
