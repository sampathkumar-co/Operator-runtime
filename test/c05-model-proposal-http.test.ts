import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRuntime } from '../apps/local-agent/src/runtime-factory.ts';
import { createLocalAgentServer } from '../apps/local-agent/src/server.ts';
import { EmergencyStopStore } from '../apps/local-agent/src/emergency-stop.ts';
import { BoundedModelGoalInference } from '../src/core/bounded-model-goal-inference.ts';
import { TrustedReviewedModelTaskIntake } from '../src/core/trusted-reviewed-model-task-intake.ts';

const approved = {
  objective: 'Open the approved documentation page',
  approvedRoots: [],
  approvedBrowserOrigins: ['https://allowed.example']
};
const proposal = {
  goal: { kind: 'browser-navigation', url: 'https://allowed.example/manual' },
  successConditions: ['Observe the matching destination']
};

test('C05 optional local-only model endpoints reject cookie/forged principal and queue only after native review', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-c05-http-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runtime = createRuntime({ allowedRoots: [root], allowedExecutables: ['node'] });
  const token = 'g'.repeat(64);
  let transmitted = 0, submitted = 0, nativeReview = 0;
  const model = new BoundedModelGoalInference({
    modelId: 'test-model', maxOutputTokens: 256, maxCostMicros: 0,
    timeoutMs: 1000, ledger: {
      async reserve() { return { reservationId: 'durable-fixture' }; },
      async finalize() {}
    },
    generator: { async generate() {
      transmitted++;
      return { text: JSON.stringify(proposal) };
    } }
  });
  const intake = new TrustedReviewedModelTaskIntake({
    model, authority: {
      async currentApprovedScope(principal) {
        return principal === 'runtime-bound-owner' ? approved : null;
      },
      async verifyTrustedReview(input) {
        nativeReview++;
        return input.principal === 'runtime-bound-owner' && input.reviewProof === 'trusted-native-confirmation';
      },
      async submitReviewedTask(options) {
        submitted++;
        assert.equal(options.goal.kind, 'browser-navigation');
        return { id: 'queued-task-' + submitted, executionStarted: false as const };
      }
    }
  });
  const server = createLocalAgentServer({
    runtime, token, permissions: { allowedCapabilities: ['browser.navigate'], allowedRoots: [root] },
    modelTaskIntake: intake,
    resolveModelPrincipal: () => 'runtime-bound-owner'
  });
  t.after(async () => { await Promise.allSettled([server.close(), runtime.close()]); });
  const bound = await server.listen('127.0.0.1', 0);
  const base = 'http://127.0.0.1:' + bound.port;
  const send = (route: string, body: unknown, headers: Record<string,string> = {}) =>
    fetch(base + route, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body)
    });
  const bearer = { authorization: 'Bearer ' + token };
  const payload = { request: approved, allowModelTransmission: true };
  const unauth = await send('/v1/model-proposals', payload);
  assert.equal(unauth.status, 401);
  const cookie = await send('/v1/model-proposals', payload, { cookie: 'operator_session=forged' });
  assert.equal(cookie.status, 401);
  assert.equal(transmitted, 0);
  const principalSpoof = await send('/v1/model-proposals', { ...payload, principal: 'attacker' }, bearer);
  assert.equal(principalSpoof.status, 409);
  assert.equal(transmitted, 0);
  const noConsent = await send('/v1/model-proposals', { request: approved }, bearer);
  assert.equal(noConsent.status, 409);
  assert.equal(transmitted, 0);
  const initiated = await send('/v1/model-proposals', payload, bearer);
  assert.equal(initiated.status, 200);
  const draft = await initiated.json() as any;
  assert.equal(draft.ok, true);
  assert.equal(draft.executionStarted, false);
  assert.equal(transmitted, 1);
  assert.equal(submitted, 0);

  const challenge = { proposalId: draft.proposalId, proposalDigest: draft.proposalDigest };
  const bad = await send('/v1/model-proposals/confirm', { ...challenge, reviewProof: true }, bearer);
  assert.equal(bad.status, 409);
  assert.equal(submitted, 0);
  const runInjection = await send('/v1/model-proposals/confirm', {
    ...challenge, reviewProof: 'trusted-native-confirmation', run: true
  }, bearer);
  assert.equal(runInjection.status, 409);
  const confirmation = await send('/v1/model-proposals/confirm', {
    ...challenge, reviewProof: 'trusted-native-confirmation'
  }, bearer);
  assert.equal(confirmation.status, 202);
  assert.deepEqual(await confirmation.json(), {
    ok: true, taskId: 'queued-task-1', executionStarted: false
  });
  assert.equal(submitted, 1);
  assert.ok(nativeReview >= 2);
  const replay = await send('/v1/model-proposals/confirm', {
    ...challenge, reviewProof: 'trusted-native-confirmation'
  }, bearer);
  assert.equal(replay.status, 409);
  assert.equal(submitted, 1);
});

test('C05 unconfigured model routes never imply local model or reviewer availability', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-c05-unconfigured-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runtime = createRuntime({ allowedRoots: [root], allowedExecutables: ['node'] });
  const token = 'h'.repeat(64);
  const server = createLocalAgentServer({
    runtime, token, permissions: { allowedCapabilities: [], allowedRoots: [root] }
  });
  t.after(async () => { await Promise.allSettled([server.close(), runtime.close()]); });
  const bound = await server.listen('127.0.0.1', 0);
  const result = await fetch('http://127.0.0.1:' + bound.port + '/v1/model-proposals', {
    method: 'POST', headers: {
      authorization: 'Bearer ' + token, 'content-type': 'application/json'
    },
    body: '{}'
  });
  assert.equal(result.status, 503);
  assert.equal((await result.json() as any).error.code, 'MODEL_TASK_INTAKE_NOT_CONFIGURED');
});

test('C05 emergency Stop burns pending native model reviews across subsequent clear', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-c05-stop-reviews-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runtime = createRuntime({ allowedRoots: [root], allowedExecutables: ['node'] });
  const emergencyStop = new EmergencyStopStore(root);
  const token = 'j'.repeat(64), recovery = 'k'.repeat(64);
  let queued = 0;
  const model = new BoundedModelGoalInference({
    modelId: 'test-model', maxOutputTokens: 256, maxCostMicros: 0, timeoutMs: 1000,
    ledger: {
      async reserve() { return { reservationId: 'synthetic-reserved' }; },
      async finalize() {}
    },
    generator: { async generate() { return { text: JSON.stringify(proposal) }; } }
  });
  const intake = new TrustedReviewedModelTaskIntake({
    model, authority: {
      async currentApprovedScope() { return approved; },
      async verifyTrustedReview() { return true; },
      async submitReviewedTask() {
        queued++;
        return { id: 'no-pending-queue-' + queued, executionStarted: false as const };
      }
    }
  });
  const server = createLocalAgentServer({
    runtime, token, recoveryToken: recovery, emergencyStop,
    modelTaskIntake: intake, resolveModelPrincipal: () => 'native-trusted-principal',
    permissions: { allowedCapabilities: ['browser.navigate'], allowedRoots: [root] }
  });
  t.after(async () => { await Promise.allSettled([server.close(), runtime.close()]); });
  const { port } = await server.listen('127.0.0.1', 0);
  const url = 'http://127.0.0.1:' + port;
  const send = async (endpoint: string, method: string, body: unknown, extra: Record<string, string> = {}) =>
    fetch(url + endpoint, {
      method, headers: {
        authorization: 'Bearer ' + token,
        'content-type': 'application/json', ...extra
      },
      ...(method === 'DELETE' ? {} : { body: JSON.stringify(body) })
    });
  const proposed = await send('/v1/model-proposals', 'POST',
    { request: approved, allowModelTransmission: true });
  assert.equal(proposed.status, 200);
  const draft = await proposed.json() as any;
  const stop = await send('/v1/emergency-stop', 'POST', { reason: 'Stop test-only private review' });
  assert.equal(stop.status, 200);
  const blocked = await send('/v1/model-proposals/confirm', 'POST', {
    proposalId: draft.proposalId, proposalDigest: draft.proposalDigest,
    reviewProof: 'native-confirmation'
  });
  assert.equal(blocked.status, 423);
  const clear = await send('/v1/emergency-stop', 'DELETE', undefined,
    { 'x-operator-recovery-token': recovery });
  assert.equal(clear.status, 200);
  const stale = await send('/v1/model-proposals/confirm', 'POST', {
    proposalId: draft.proposalId, proposalDigest: draft.proposalDigest,
    reviewProof: 'native-confirmation'
  });
  assert.equal(stale.status, 409, 'Original pre-stop review must have been destroyed');
  assert.equal(queued, 0);
});
