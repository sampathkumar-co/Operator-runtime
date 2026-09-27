import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TeamCoordinator } from '../src/core/team-coordinator.ts';
import { createRuntime } from '../apps/local-agent/src/runtime-factory.ts';
import { createLocalAgentServer } from '../apps/local-agent/src/server.ts';

function resourceForFile(file: string): string {
  const normalized = path.resolve(file).replace(/\\/g, '/');
  return 'file:' + (process.platform === 'win32' ? normalized.toLowerCase() : normalized);
}

test('stage4 local API coordinates claimed worker execution through the real runtime', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-team-api-root-'));
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-team-api-state-'));
  t.after(() => Promise.all([
    fs.rm(root, { recursive: true, force: true }),
    fs.rm(state, { recursive: true, force: true })
  ]));
  const file = path.join(root, 'shared.txt');
  const resource = resourceForFile(file);
  const teams = new TeamCoordinator(state);
  const runtime = createRuntime({ allowedRoots: [root], allowedExecutables: ['node'] });
  const token = 't'.repeat(64);
  const agent = createLocalAgentServer({
    runtime,
    token,
    teams,
    permissions: { allowedCapabilities: ['file.*'], allowedRoots: [root] }
  });
  t.after(() => Promise.allSettled([agent.close(), runtime.close()]));
  const bound = await agent.listen('127.0.0.1', 0);
  const base = 'http://127.0.0.1:' + bound.port;
  const headers = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };

  const unauthorized = await fetch(base + '/v1/teams');
  assert.equal(unauthorized.status, 401);

  const submit = await fetch(base + '/v1/teams', {
    method: 'POST', headers,
    body: JSON.stringify({
      objective: 'Write and independently verify one shared file',
      run: true,
      workItems: [
        { key: 'code', title: 'Write file', role: 'coder', risk: 'write', resources: [resource], allowedCapabilities: ['file.write'] },
        { key: 'verify', title: 'Verify file', role: 'verifier', risk: 'read', dependsOn: ['code'], resources: [resource], allowedCapabilities: ['file.read'] }
      ]
    })
  });
  assert.equal(submit.status, 200);
  const submitted = await submit.json() as any;
  const missionId = submitted.mission.id as string;

  async function register(role: 'coder' | 'verifier', capabilities: string[]) {
    const response = await fetch(base + '/v1/teams/' + missionId + '/workers/register', {
      method: 'POST', headers, body: JSON.stringify({ role, label: role, capabilities })
    });
    assert.equal(response.status, 200);
    return (await response.json() as any).worker as { id: string };
  }
  const coder = await register('coder', ['file.write']);
  const verifier = await register('verifier', ['file.read']);

  const coderClaimResponse = await fetch(base + '/v1/teams/' + missionId + '/claim', {
    method: 'POST', headers, body: JSON.stringify({ workerId: coder.id })
  });
  assert.equal(coderClaimResponse.status, 200);
  const coderClaim = await coderClaimResponse.json() as any;
  assert.equal(coderClaim.workItem.key, 'code');

  const writeResponse = await fetch(base + '/v1/teams/' + missionId + '/work/' + coderClaim.workItem.id + '/execute', {
    method: 'POST', headers,
    body: JSON.stringify({
      workerId: coder.id,
      leaseId: coderClaim.workItem.lease.id,
      action: {
        id: crypto.randomUUID(), capability: 'file.write', risk: 'write',
        input: { path: file, content: 'stage4' }, provenance: { kind: 'chatgpt' }
      }
    })
  });
  assert.equal(writeResponse.status, 200, JSON.stringify(await writeResponse.clone().json()));
  assert.equal(await fs.readFile(file, 'utf8'), 'stage4');

  const coderComplete = await fetch(base + '/v1/teams/' + missionId + '/work/' + coderClaim.workItem.id + '/complete', {
    method: 'POST', headers,
    body: JSON.stringify({ workerId: coder.id, leaseId: coderClaim.workItem.lease.id, summary: 'wrote file' })
  });
  assert.equal(coderComplete.status, 200);

  const verifyClaimResponse = await fetch(base + '/v1/teams/' + missionId + '/claim', {
    method: 'POST', headers, body: JSON.stringify({ workerId: verifier.id })
  });
  assert.equal(verifyClaimResponse.status, 200);
  const verifyClaim = await verifyClaimResponse.json() as any;
  assert.equal(verifyClaim.workItem.key, 'verify');

  const readResponse = await fetch(base + '/v1/teams/' + missionId + '/work/' + verifyClaim.workItem.id + '/execute', {
    method: 'POST', headers,
    body: JSON.stringify({
      workerId: verifier.id,
      leaseId: verifyClaim.workItem.lease.id,
      action: {
        id: crypto.randomUUID(), capability: 'file.read', risk: 'read',
        input: { path: file }, provenance: { kind: 'chatgpt' }
      }
    })
  });
  assert.equal(readResponse.status, 200);
  const read = await readResponse.json() as any;
  assert.equal(read.output.content, 'stage4');

  const verifyComplete = await fetch(base + '/v1/teams/' + missionId + '/work/' + verifyClaim.workItem.id + '/complete', {
    method: 'POST', headers,
    body: JSON.stringify({
      workerId: verifier.id,
      leaseId: verifyClaim.workItem.lease.id,
      summary: 'verified exact content',
      verificationPassed: true,
      evidence: [{ kind: 'file', status: 'pass', message: 'content matched' }]
    })
  });
  assert.equal(verifyComplete.status, 200);
  const verified = await verifyComplete.json() as any;
  assert.equal(verified.mission.state, 'VERIFIED');
  assert.equal(verified.mission.resources[0].revision, 1);
});
