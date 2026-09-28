import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TeachModeStore } from '../src/core/studio-teach.ts';
import { StudioWorkflowExecutor } from '../src/core/studio-executor.ts';
import { OperatorRuntime } from '../src/core/runtime.ts';
import { ResourceLeaseStore } from '../src/core/resource-leases.ts';
import type { ActionRequest, ActionResult, CapabilityProvider, CapabilityScore } from '../src/core/types.ts';
import { createLocalAgentServer } from '../apps/local-agent/src/server.ts';

const SCORE: CapabilityScore = {
  reliability: 1, latency: 0, determinism: 1, security: 1,
  reversibility: 1, informationQuality: 1, interactionCost: 0
};

class ApiProbeProvider implements CapabilityProvider {
  readonly name = 'studio-api-probe';
  supports(action: ActionRequest): boolean { return action.capability === 'file.read'; }
  score(): CapabilityScore { return SCORE; }
  async execute(action: ActionRequest): Promise<ActionResult> {
    return {
      ok: true,
      capability: action.capability,
      provider: this.name,
      output: { text: 'ok' },
      evidence: [{ kind: 'read', status: 'pass', message: 'current file state observed', timestamp: new Date().toISOString() }],
      durationMs: 1
    };
  }
}

async function temp(t: test.TestContext, prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function compileReadWorkflow(teach: TeachModeStore, file: string) {
  const session = await teach.start({ title: 'Read workflow', objective: 'Read a project file', scopeKey: 'project:api' });
  await teach.record(session.id, {
    action: {
      id: 'demo-read', capability: 'file.read', risk: 'read',
      input: { path: file }, provenance: { kind: 'user' }
    },
    result: {
      ok: true, capability: 'file.read', provider: 'demo',
      evidence: [{ kind: 'demo', status: 'pass', message: 'read demonstrated', timestamp: new Date().toISOString() }],
      durationMs: 1
    }
  });
  await teach.stop(session.id);
  const receipt = await teach.verify(session.id, [{
    name: 'demo-verified',
    ok: true,
    detail: 'Independent verifier confirmed the demonstrated read.',
    evidenceDigests: []
  }]);
  return await teach.compile(session.id, { verificationReceipt: receipt });
}

test('Stage19 private API creates, executes, inspects and independently verifies a durable Studio run', async (t) => {
  const state = await temp(t, 'operator-studio-api-state-');
  const root = await temp(t, 'operator-studio-api-root-');
  const teach = new TeachModeStore(state);
  const workflow = await compileReadWorkflow(teach, path.join(root, 'a.txt'));
  const runtime = new OperatorRuntime().register(new ApiProbeProvider());
  const executor = new StudioWorkflowExecutor(state, {
    teach, runtime, leases: new ResourceLeaseStore(state),
    permissions: { allowedCapabilities: ['file.read'], allowedRoots: [root] }
  });
  const token = 's'.repeat(64);
  const agent = createLocalAgentServer({
    runtime, token, teachMode: teach, studioExecutor: executor,
    permissions: { allowedCapabilities: ['file.read'], allowedRoots: [root] }
  });
  t.after(() => Promise.allSettled([agent.close(), runtime.close()]));
  const bound = await agent.listen('127.0.0.1', 0);
  const base = `http://127.0.0.1:${bound.port}`;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  const unauth = await fetch(`${base}/v1/studio/workflows/${workflow.id}/run`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
  });
  assert.equal(unauth.status, 401);

  const createdResponse = await fetch(`${base}/v1/studio/workflows/${workflow.id}/run`, {
    method: 'POST', headers, body: JSON.stringify({ values: {} })
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json() as any;
  assert.equal(created.run.state, 'PENDING');

  const executedResponse = await fetch(`${base}/v1/studio/runs/${created.run.id}/execute`, {
    method: 'POST', headers, body: JSON.stringify({ maxSteps: 1 })
  });
  assert.equal(executedResponse.status, 200);
  const executed = await executedResponse.json() as any;
  assert.equal(executed.run.state, 'AWAITING_VERIFICATION');
  assert.equal(executed.run.steps[0].provider, 'studio-api-probe');

  const inspectResponse = await fetch(`${base}/v1/studio/runs/${created.run.id}`, { headers });
  assert.equal(inspectResponse.status, 200);
  assert.equal((await inspectResponse.json() as any).run.state, 'AWAITING_VERIFICATION');

  const verifyResponse = await fetch(`${base}/v1/studio/runs/${created.run.id}/verify`, {
    method: 'POST', headers,
    body: JSON.stringify({ checks: [{
      name: 'current-outcome',
      ok: true,
      detail: 'Independent verifier observed the current required outcome.',
      evidenceDigests: [executed.run.steps[0].evidenceDigest]
    }] })
  });
  assert.equal(verifyResponse.status, 200);
  assert.equal((await verifyResponse.json() as any).run.state, 'VERIFIED');
});

test('Stage19 persisted verification receipt tampering fails closed', async (t) => {
  const state = await temp(t, 'operator-studio-tamper-state-');
  const root = await temp(t, 'operator-studio-tamper-root-');
  const teach = new TeachModeStore(state);
  const workflow = await compileReadWorkflow(teach, path.join(root, 'a.txt'));
  const runtime = new OperatorRuntime().register(new ApiProbeProvider());
  t.after(() => runtime.close());
  const executor = new StudioWorkflowExecutor(state, {
    teach, runtime, leases: new ResourceLeaseStore(state),
    permissions: { allowedCapabilities: ['file.read'], allowedRoots: [root] }
  });
  const run = await executor.submit(workflow.id, {});
  const completed = await executor.execute(run.id);
  await executor.verify(run.id, [{
    name: 'outcome', ok: true, detail: 'Verified outcome.', evidenceDigests: [completed.steps[0]!.evidenceDigest!]
  }]);

  const file = path.join(state, 'studio-runs.json');
  const raw = JSON.parse(await fs.readFile(file, 'utf8')) as any;
  raw.runs[0].verificationReceipt.checks[0].detail = 'tampered detail';
  await fs.writeFile(file, JSON.stringify(raw, null, 2), 'utf8');

  const reloaded = new StudioWorkflowExecutor(state, {
    teach, runtime, leases: new ResourceLeaseStore(state),
    permissions: { allowedCapabilities: ['file.read'], allowedRoots: [root] }
  });
  await assert.rejects(
    () => reloaded.inspect(run.id),
    (error: any) => error?.code === 'STUDIO_RUN_STATE_CORRUPT'
  );
});
