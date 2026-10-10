import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TeamCoordinator } from '../src/core/team-coordinator.ts';

async function stateDir(t: test.TestContext): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-team-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('stage4 requires a verifier that covers every non-verifier work item', async (t) => {
  const coordinator = new TeamCoordinator(await stateDir(t));
  await assert.rejects(
    coordinator.submit({
      objective: 'invalid mission',
      workItems: [{ key: 'code', title: 'Code', role: 'coder' }]
    }),
    /verifier/i
  );
  await assert.rejects(
    coordinator.submit({
      objective: 'uncovered mission',
      workItems: [
        { key: 'code', title: 'Code', role: 'coder' },
        { key: 'test', title: 'Test', role: 'tester' },
        { key: 'verify', title: 'Verify', role: 'verifier', dependsOn: ['code'] }
      ]
    }),
    /depend on every non-verifier/i
  );
});

test('team mission lock reclaims a reused PID only when the process instance identity changed', async (t) => {
  const state = await stateDir(t);
  const coordinator = new TeamCoordinator(state, {
    processInstance: { pid: 44002, started: 'new-owner' },
    inspectProcessInstance: async (pid) => pid === 44001 ? { pid, started: 'reused-instance' } : { pid, started: 'new-owner' }
  });
  const mission = await coordinator.submit({
    objective: 'pid reuse lock recovery',
    workItems: [{ key: 'verify', title: 'Verify', role: 'verifier' }]
  });
  await fs.writeFile(path.join(state, 'team-mission-locks', `${mission.id}.lock`), JSON.stringify({
    id: 'stale-lock',
    pid: 44001,
    processInstance: { pid: 44001, started: 'old-instance' },
    at: new Date().toISOString()
  }));

  const started = await coordinator.start(mission.id);
  assert.equal(started.state, 'RUNNING');
});

test('stage4 deterministically schedules dependencies and parallel independent resources', async (t) => {
  const coordinator = new TeamCoordinator(await stateDir(t));
  const mission = await coordinator.submit({
    objective: 'parallel feature',
    budget: { maxConcurrentLeases: 2 },
    workItems: [
      { key: 'backend', title: 'Backend', role: 'coder', priority: 10, risk: 'write', resources: ['file:src/api.ts'], allowedCapabilities: ['file.replace'] },
      { key: 'frontend', title: 'Frontend', role: 'ui', priority: 10, risk: 'write', resources: ['file:src/page.tsx'], allowedCapabilities: ['file.replace'] },
      { key: 'tests', title: 'Tests', role: 'tester', risk: 'read', dependsOn: ['backend', 'frontend'], resources: ['repo:root'], allowedCapabilities: ['project.command.run'] },
      { key: 'verify', title: 'Verify', role: 'verifier', risk: 'read', dependsOn: ['tests'], resources: ['repo:root'], allowedCapabilities: ['project.inspect'] }
    ]
  });
  await coordinator.start(mission.id);
  const coder = (await coordinator.registerWorker(mission.id, { role: 'coder', label: 'coder', capabilities: ['file.replace'] })).worker;
  const ui = (await coordinator.registerWorker(mission.id, { role: 'ui', label: 'ui', capabilities: ['file.replace'] })).worker;
  const tester = (await coordinator.registerWorker(mission.id, { role: 'tester', label: 'tester', capabilities: ['project.command.run'] })).worker;
  const verifier = (await coordinator.registerWorker(mission.id, { role: 'verifier', label: 'verifier', capabilities: ['project.inspect'] })).worker;

  const [coderClaim, uiClaim] = await Promise.all([
    coordinator.claim(mission.id, { workerId: coder.id }),
    coordinator.claim(mission.id, { workerId: ui.id })
  ]);
  assert.equal(coderClaim.workItem?.key, 'backend');
  assert.equal(uiClaim.workItem?.key, 'frontend');
  assert.notEqual(coderClaim.workItem?.lease?.id, uiClaim.workItem?.lease?.id);

  const earlyTest = await coordinator.claim(mission.id, { workerId: tester.id });
  assert.equal(earlyTest.workItem, undefined);

  await coordinator.complete(mission.id, {
    workerId: coder.id, workItemId: coderClaim.workItem!.id, leaseId: coderClaim.workItem!.lease!.id,
    summary: 'backend complete', evidence: [{ kind: 'unit', status: 'pass', message: 'backend passed' }]
  });
  await coordinator.complete(mission.id, {
    workerId: ui.id, workItemId: uiClaim.workItem!.id, leaseId: uiClaim.workItem!.lease!.id,
    summary: 'frontend complete', evidence: [{ kind: 'unit', status: 'pass', message: 'frontend passed' }]
  });

  const testClaim = await coordinator.claim(mission.id, { workerId: tester.id });
  assert.equal(testClaim.workItem?.key, 'tests');
  await coordinator.complete(mission.id, {
    workerId: tester.id, workItemId: testClaim.workItem!.id, leaseId: testClaim.workItem!.lease!.id,
    summary: 'tests pass', evidence: [{ kind: 'tests', status: 'pass', message: 'all green' }]
  });

  const verifyClaim = await coordinator.claim(mission.id, { workerId: verifier.id });
  assert.equal(verifyClaim.workItem?.key, 'verify');
  const completed = await coordinator.complete(mission.id, {
    workerId: verifier.id, workItemId: verifyClaim.workItem!.id, leaseId: verifyClaim.workItem!.lease!.id,
    summary: 'independent verification passed', verificationPassed: true,
    evidence: [{ kind: 'verification', status: 'pass', message: 'accepted' }]
  });
  assert.equal(completed.state, 'VERIFIED');
  assert.equal(completed.resources.find((resource) => resource.key === 'file:src/api.ts')?.revision, 1);
  assert.equal(completed.resources.find((resource) => resource.key === 'file:src/page.tsx')?.revision, 1);
});

test('stage4 resource locks prevent conflicting workers from claiming the same artifact', async (t) => {
  const coordinator = new TeamCoordinator(await stateDir(t));
  const mission = await coordinator.submit({
    objective: 'conflict prevention',
    budget: { maxConcurrentLeases: 4 },
    workItems: [
      { key: 'a', title: 'A', role: 'coder', risk: 'write', resources: ['file:src/shared.ts'] },
      { key: 'b', title: 'B', role: 'coder', risk: 'write', resources: ['file:src/shared.ts'] },
      { key: 'verify', title: 'Verify', role: 'verifier', dependsOn: ['a', 'b'] }
    ]
  });
  await coordinator.start(mission.id);
  const first = (await coordinator.registerWorker(mission.id, { role: 'coder', label: 'first' })).worker;
  const second = (await coordinator.registerWorker(mission.id, { role: 'coder', label: 'second' })).worker;

  const [one, two] = await Promise.all([
    coordinator.claim(mission.id, { workerId: first.id }),
    coordinator.claim(mission.id, { workerId: second.id })
  ]);
  assert.equal([one.workItem, two.workItem].filter(Boolean).length, 1);
  const claimed = one.workItem ?? two.workItem!;
  const owner = one.workItem ? first : second;
  await coordinator.complete(mission.id, {
    workerId: owner.id, workItemId: claimed.id, leaseId: claimed.lease!.id, summary: 'first mutation complete'
  });
  const other = one.workItem ? second : first;
  const next = await coordinator.claim(mission.id, { workerId: other.id });
  assert.ok(next.workItem);
  assert.notEqual(next.workItem!.key, claimed.key);
});

test('stage4 pause makes in-flight mutation uncertain and requires explicit reconciliation', async (t) => {
  const coordinator = new TeamCoordinator(await stateDir(t));
  const mission = await coordinator.submit({
    objective: 'safe interruption',
    workItems: [
      { key: 'mutate', title: 'Mutate', role: 'coder', risk: 'write', resources: ['file:src/state.ts'] },
      { key: 'verify', title: 'Verify', role: 'verifier', dependsOn: ['mutate'], resources: ['file:src/state.ts'] }
    ]
  });
  await coordinator.start(mission.id);
  const coder = (await coordinator.registerWorker(mission.id, { role: 'coder', label: 'coder' })).worker;
  const supervisor = (await coordinator.registerWorker(mission.id, { role: 'supervisor', label: 'supervisor' })).worker;
  const claim = await coordinator.claim(mission.id, { workerId: coder.id });
  assert.equal(claim.workItem?.key, 'mutate');

  const paused = await coordinator.pause(mission.id);
  assert.equal(paused.state, 'PAUSED');
  assert.equal(paused.workItems.find((item) => item.key === 'mutate')?.state, 'NEEDS_RECONCILIATION');
  assert.equal(paused.resources[0]?.uncertain, true);
  await assert.rejects(coordinator.resume(mission.id), /reconciled/i);

  const reconciled = await coordinator.reconcile(mission.id, {
    workerId: supervisor.id,
    workItemId: paused.workItems.find((item) => item.key === 'mutate')!.id,
    resolution: 'retry',
    summary: 'inspected resource; mutation did not complete',
    evidence: [{ kind: 'reconcile', status: 'pass', message: 'safe to retry' }]
  });
  assert.equal(reconciled.resources[0]?.uncertain, false);
  assert.equal(reconciled.workItems.find((item) => item.key === 'mutate')?.state, 'PENDING');
  const resumed = await coordinator.resume(mission.id);
  assert.equal(resumed.state, 'RUNNING');
});

test('stage4 stale or revoked worker cannot complete an invalidated lease', async (t) => {
  const coordinator = new TeamCoordinator(await stateDir(t));
  const mission = await coordinator.submit({
    objective: 'lease invalidation',
    workItems: [
      { key: 'read', title: 'Read', role: 'planner', risk: 'read', resources: ['repo:root'] },
      { key: 'verify', title: 'Verify', role: 'verifier', dependsOn: ['read'] }
    ]
  });
  await coordinator.start(mission.id);
  const worker = (await coordinator.registerWorker(mission.id, { role: 'planner', label: 'planner' })).worker;
  const claim = await coordinator.claim(mission.id, { workerId: worker.id });
  await coordinator.revokeWorker(mission.id, { workerId: worker.id });
  await assert.rejects(
    coordinator.complete(mission.id, {
      workerId: worker.id, workItemId: claim.workItem!.id, leaseId: claim.workItem!.lease!.id, summary: 'late result'
    }),
    /revoked|lease/i
  );
  const current = await coordinator.inspect(mission.id);
  assert.equal(current.workItems.find((item) => item.key === 'read')?.state, 'PENDING');
});

test('stage4 role capability matching prevents unsuitable workers from claiming work', async (t) => {
  const coordinator = new TeamCoordinator(await stateDir(t));
  const mission = await coordinator.submit({
    objective: 'capability matching',
    workItems: [
      { key: 'code', title: 'Code', role: 'coder', allowedCapabilities: ['file.replace'] },
      { key: 'verify', title: 'Verify', role: 'verifier', dependsOn: ['code'] }
    ]
  });
  await coordinator.start(mission.id);
  const weak = (await coordinator.registerWorker(mission.id, { role: 'coder', label: 'weak', capabilities: ['file.read'] })).worker;
  const strong = (await coordinator.registerWorker(mission.id, { role: 'coder', label: 'strong', capabilities: ['file.read', 'file.replace'] })).worker;
  assert.equal((await coordinator.claim(mission.id, { workerId: weak.id })).workItem, undefined);
  assert.equal((await coordinator.claim(mission.id, { workerId: strong.id })).workItem?.key, 'code');
});


test('stage4 shared blackboard uses lease-bound CAS revisions to prevent lost updates', async (t) => {
  const coordinator = new TeamCoordinator(await stateDir(t));
  const mission = await coordinator.submit({
    objective: 'shared blackboard',
    workItems: [
      { key: 'plan', title: 'Plan', role: 'planner', risk: 'read' },
      { key: 'verify', title: 'Verify', role: 'verifier', dependsOn: ['plan'] }
    ]
  });
  await coordinator.start(mission.id);
  const planner = (await coordinator.registerWorker(mission.id, { role: 'planner', label: 'planner' })).worker;
  const supervisor = (await coordinator.registerWorker(mission.id, { role: 'supervisor', label: 'supervisor' })).worker;
  const claim = await coordinator.claim(mission.id, { workerId: planner.id });
  assert.equal(claim.workItem?.key, 'plan');

  const first = await coordinator.putBlackboard(mission.id, {
    workerId: planner.id,
    workItemId: claim.workItem!.id,
    leaseId: claim.workItem!.lease!.id,
    key: 'architecture',
    expectedRevision: 0,
    value: { choice: 'A', owner: 'planner' }
  });
  assert.equal(first.blackboard[0]?.revision, 1);
  assert.deepEqual(first.blackboard[0]?.value, { choice: 'A', owner: 'planner' });

  await assert.rejects(
    coordinator.putBlackboard(mission.id, {
      workerId: planner.id,
      workItemId: claim.workItem!.id,
      leaseId: claim.workItem!.lease!.id,
      key: 'architecture',
      expectedRevision: 0,
      value: { choice: 'stale' }
    }),
    (error: any) => error?.code === 'TEAM_BLACKBOARD_CONFLICT'
  );

  const second = await coordinator.putBlackboard(mission.id, {
    workerId: supervisor.id,
    key: 'architecture',
    expectedRevision: 1,
    value: { choice: 'A', approved: true }
  });
  assert.equal(second.blackboard[0]?.revision, 2);
  assert.deepEqual(second.blackboard[0]?.value, { choice: 'A', approved: true });
});


test('stage4 recent mission listing sorts by updatedAt before applying the page limit', async (t) => {
  const coordinator = new TeamCoordinator(await stateDir(t));
  const missions = [];
  for (let index = 0; index < 20; index += 1) {
    missions.push(await coordinator.submit({
      objective: `mission-${index}`,
      workItems: [{ key: 'verify', title: 'Verify', role: 'verifier' }]
    }));
  }

  const lexicallyLast = missions.slice().sort((a, b) => a.id.localeCompare(b.id)).at(-1)!;
  await coordinator.start(lexicallyLast.id);
  const recent = await coordinator.list(10);
  assert.equal(recent[0]?.id, lexicallyLast.id);
  assert.ok(recent.some((item) => item.id === lexicallyLast.id));
});


test('team mission lock never steals ownership when process liveness is unknown', async (t) => {
  const state = await stateDir(t);
  const coordinator = new TeamCoordinator(state, {
    processInstance: { pid: 44102, started: 'new-owner' },
    observeProcessInstance: async () => ({ status: 'unknown' })
  });
  const mission = await coordinator.submit({
    objective: 'unknown liveness lock retention',
    workItems: [{ key: 'verify', title: 'Verify', role: 'verifier' }]
  });
  const lockPath = path.join(state, 'team-mission-locks', `${mission.id}.lock`);
  await fs.writeFile(lockPath, JSON.stringify({
    id: 'existing-lock',
    pid: 44101,
    processInstance: { pid: 44101, started: 'existing-instance' },
    at: new Date().toISOString()
  }));

  await assert.rejects(
    () => coordinator.start(mission.id),
    (error: any) => error?.code === 'TEAM_LOCK_BUSY'
  );
  assert.equal(JSON.parse(await fs.readFile(lockPath, 'utf8')).pid, 44101);
});

for (const status of ['dead', 'reused'] as const) {
  test('sibling Linux PID namespace ' + status + ' probe cannot steal team mission lock', async t => {
    const state = await stateDir(t);
    const boot = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    let observed = 0;
    const coordinator = new TeamCoordinator(state, {
      processInstance: { pid: 44002, started: 'linux-boot-id:' + boot + ':pidns:10002:ticks:20' },
      observeProcessInstance: async pid => {
        observed++;
        return status === 'dead' ? { status: 'dead' as const }
          : { status: 'live' as const, identity: {
            pid, started: 'linux-boot-id:' + boot + ':pidns:10002:ticks:21'
          } };
      }
    });
    const mission = await coordinator.submit({
      objective: 'Separate namespace mission lock fencing',
      workItems: [{ key: 'verify', title: 'Verify', role: 'verifier' }]
    });
    const file = path.join(state, 'team-mission-locks', mission.id + '.lock');
    const remote = {
      id: crypto.randomUUID(), pid: 44001,
      processInstance: { pid: 44001, started: 'linux-boot-id:' + boot + ':pidns:10001:ticks:10' },
      at: new Date().toISOString()
    };
    await fs.writeFile(file, JSON.stringify(remote));
    await assert.rejects(() => coordinator.start(mission.id),
      (error: any) => error?.code === 'TEAM_LOCK_BUSY');
    assert.equal(observed, 0);
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), remote);
  });
}

test('same-namespace proven dead mission lock can be reclaimed', async t => {
  const state = await stateDir(t);
  const boot = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const coordinator = new TeamCoordinator(state, {
    processInstance: { pid: 44002, started: 'linux-boot-id:' + boot + ':pidns:7777:ticks:20' },
    observeProcessInstance: async () => ({ status: 'dead' as const })
  });
  const mission = await coordinator.submit({
    objective: 'Same namespace mission recovery',
    workItems: [{ key: 'verify', title: 'Verify', role: 'verifier' }]
  });
  const file = path.join(state, 'team-mission-locks', mission.id + '.lock');
  await fs.writeFile(file, JSON.stringify({
    id: crypto.randomUUID(), pid: 44001,
    processInstance: { pid: 44001, started: 'linux-boot-id:' + boot + ':pidns:7777:ticks:10' },
    at: new Date().toISOString()
  }));
  const started = await coordinator.start(mission.id);
  assert.equal(started.state, 'RUNNING');
});
