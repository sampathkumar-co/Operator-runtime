import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TeamCoordinator } from '../src/core/team-coordinator.ts';
import { WorldModelStore } from '../src/core/world-model.ts';
import { createRuntime } from '../apps/local-agent/src/runtime-factory.ts';
import { createLocalAgentServer } from '../apps/local-agent/src/server.ts';

async function stateDir(t: test.TestContext): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-world-publish-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('stage6 local API publishes only verifier-committed world observations and locks retry to exact payload', async (t) => {
  const state = await stateDir(t);
  const teams = new TeamCoordinator(state);
  const world = new WorldModelStore(state);
  const runtime = createRuntime({ allowedRoots: [state], allowedExecutables: ['node'] });
  const token = 'w'.repeat(64);
  const agent = createLocalAgentServer({
    runtime, token, teams, world,
    permissions: { allowedCapabilities: ['file.read'], allowedRoots: [state] }
  });
  t.after(() => Promise.allSettled([agent.close(), runtime.close()]));
  const bound = await agent.listen('127.0.0.1', 0);
  const base = 'http://127.0.0.1:' + bound.port;
  const headers = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };

  const mission = await teams.submit({
    objective: 'Verify service health',
    workItems: [
      { key: 'inspect', title: 'Inspect', role: 'general', risk: 'read' },
      { key: 'verify', title: 'Verify', role: 'verifier', risk: 'read', dependsOn: ['inspect'] }
    ]
  });
  await teams.start(mission.id);
  const worker = (await teams.registerWorker(mission.id, { role: 'general', label: 'worker' })).worker;
  const verifier = (await teams.registerWorker(mission.id, { role: 'verifier', label: 'verifier' })).worker;
  const first = await teams.claim(mission.id, { workerId: worker.id });
  await teams.complete(mission.id, {
    workerId: worker.id, workItemId: first.workItem!.id, leaseId: first.workItem!.lease!.id, summary: 'inspection done'
  });
  const claim = await teams.claim(mission.id, { workerId: verifier.id });

  const observations = [{
    entity: { key: 'service:api', type: 'service', scopeKey: 'project:shop', label: 'API' },
    domain: 'application',
    facts: { health: 'healthy' },
    confidence: 0.95,
    ttlMs: 60_000
  }];

  const complete = await fetch(base + '/v1/teams/' + mission.id + '/work/' + claim.workItem!.id + '/complete', {
    method: 'POST', headers,
    body: JSON.stringify({
      workerId: verifier.id,
      leaseId: claim.workItem!.lease!.id,
      summary: 'verified API',
      verificationPassed: true,
      evidence: [{ kind: 'health', status: 'pass', message: 'API healthy' }],
      worldObservations: observations
    })
  });
  assert.equal(complete.status, 200);
  const body = await complete.json() as any;
  assert.equal(body.worldObservationsPublished, 1);
  assert.match(body.mission.workItems.find((item: any) => item.id === claim.workItem!.id).result.worldObservationDigest, /^[0-9a-f]{64}$/);

  const fact = await world.resolveFact('service:api', 'health');
  assert.equal(fact.status, 'resolved');
  assert.equal(fact.value, 'healthy');
  assert.match(fact.claims[0]!.evidenceDigest, /^[0-9a-f]{64}$/);
  assert.match(fact.claims[0]!.source, /^team:/);

  const exactRetry = await fetch(base + '/v1/teams/' + mission.id + '/work/' + claim.workItem!.id + '/world-publish', {
    method: 'POST', headers, body: JSON.stringify({ worldObservations: observations })
  });
  assert.equal(exactRetry.status, 200);

  const forgedRetry = await fetch(base + '/v1/teams/' + mission.id + '/work/' + claim.workItem!.id + '/world-publish', {
    method: 'POST', headers,
    body: JSON.stringify({ worldObservations: [{ ...observations[0], facts: { health: 'compromised' } }] })
  });
  assert.equal(forgedRetry.status, 409);
  assert.equal((await forgedRetry.json() as any).error.code, 'TEAM_WORLD_OBSERVATION_COMMITMENT_MISMATCH');
});

test('stage6 rejects world observations from non-verifier work', async (t) => {
  const state = await stateDir(t);
  const teams = new TeamCoordinator(state);
  const world = new WorldModelStore(state);
  const runtime = createRuntime({ allowedRoots: [state], allowedExecutables: ['node'] });
  const token = 'x'.repeat(64);
  const agent = createLocalAgentServer({
    runtime, token, teams, world,
    permissions: { allowedCapabilities: ['file.read'], allowedRoots: [state] }
  });
  t.after(() => Promise.allSettled([agent.close(), runtime.close()]));
  const bound = await agent.listen('127.0.0.1', 0);
  const base = 'http://127.0.0.1:' + bound.port;
  const headers = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };

  const mission = await teams.submit({
    objective: 'No forged world state',
    workItems: [
      { key: 'worker', title: 'Worker', role: 'general', risk: 'read' },
      { key: 'verify', title: 'Verifier', role: 'verifier', dependsOn: ['worker'] }
    ]
  });
  await teams.start(mission.id);
  const worker = (await teams.registerWorker(mission.id, { role: 'general', label: 'worker' })).worker;
  const claim = await teams.claim(mission.id, { workerId: worker.id });
  const response = await fetch(base + '/v1/teams/' + mission.id + '/work/' + claim.workItem!.id + '/complete', {
    method: 'POST', headers,
    body: JSON.stringify({
      workerId: worker.id, leaseId: claim.workItem!.lease!.id, summary: 'forged',
      verificationPassed: true,
      worldObservations: [{
        entity: { key: 'service:forged', type: 'service', scopeKey: 'project:x', label: 'Forged' },
        domain: 'application', facts: { health: 'healthy' }
      }]
    })
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json() as any).error.code, 'TEAM_WORLD_OBSERVATION_DENIED');
  assert.equal(await world.inspectEntity('service:forged'), undefined);
});
