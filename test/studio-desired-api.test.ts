import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OperatorRuntime } from '../src/core/runtime.ts';
import type { ActionRequest, ActionResult, CapabilityProvider, CapabilityScore } from '../src/core/types.ts';
import { TeachModeStore } from '../src/core/studio-teach.ts';
import { DesiredStateController } from '../src/core/desired-state.ts';
import { worldValueDigest } from '../src/core/world-model.ts';
import { createLocalAgentServer } from '../apps/local-agent/src/server.ts';

const SCORE: CapabilityScore = {
  reliability: 1, latency: 0, determinism: 1, security: 1,
  reversibility: 1, informationQuality: 1, interactionCost: 0
};

class ReadProvider implements CapabilityProvider {
  readonly name = 'teach-api-probe';
  supports(action: ActionRequest): boolean { return action.capability === 'file.read'; }
  score(): CapabilityScore { return SCORE; }
  async execute(action: ActionRequest): Promise<ActionResult> {
    return {
      ok: true,
      capability: action.capability,
      provider: this.name,
      output: { text: 'hello' },
      evidence: [{ kind: 'read', status: 'pass', message: 'read', timestamp: new Date().toISOString() }],
      durationMs: 1
    };
  }
}

class FakeWorld {
  value: unknown = 'broken';
  async resolveFact() { return { status: 'resolved' as const, value: this.value, claims: [] }; }
}

class FakeOperations {
  submitted: any[] = [];
  operations = new Map<string, any>();
  async submit(input: any) {
    this.submitted.push(structuredClone(input));
    const operation = {
      version: 1, id: input.requestId, objective: input.objective, scopeKey: input.scopeKey,
      successConditions: input.successConditions, state: 'RUNNING', mode: 'team',
      preconditions: input.preconditions ?? [], postconditions: input.postconditions ?? [],
      selectedStrategy: 'fresh-plan', submissionDigest: 'a'.repeat(64), outcomeRecorded: false,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    };
    this.operations.set(operation.id, operation);
    return structuredClone(operation);
  }
  async refresh(id: string) { return structuredClone(this.operations.get(id)); }
  async cancel(id: string) {
    const operation = this.operations.get(id);
    operation.state = 'CANCELLED';
    return structuredClone(operation);
  }
}

test('Stage19/20 private APIs require auth and Teach captures only the actual executed result', async (t) => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-stage19-api-state-'));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-stage19-api-root-'));
  t.after(() => Promise.all([
    fs.rm(state, { recursive: true, force: true }),
    fs.rm(root, { recursive: true, force: true })
  ]));

  const runtime = new OperatorRuntime().register(new ReadProvider());
  const teachMode = new TeachModeStore(state);
  const world = new FakeWorld();
  const operations = new FakeOperations();
  const desiredState = new DesiredStateController(state, { world: world as any, operations: operations as any });
  const token = 't'.repeat(64);
  const agent = createLocalAgentServer({
    runtime,
    token,
    teachMode,
    desiredState,
    permissions: { allowedCapabilities: ['file.read'], allowedRoots: [root] }
  });
  t.after(() => Promise.allSettled([agent.close(), runtime.close()]));
  const bound = await agent.listen('127.0.0.1', 0);
  const base = `http://127.0.0.1:${bound.port}`;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  assert.equal((await fetch(`${base}/v1/studio/teach`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })).status, 401);

  const startedResponse = await fetch(`${base}/v1/studio/teach`, {
    method: 'POST', headers,
    body: JSON.stringify({ title: 'Read demo', objective: 'Read a project file', scopeKey: 'project:demo' })
  });
  assert.equal(startedResponse.status, 201);
  const started = await startedResponse.json() as any;

  const executed = await fetch(`${base}/v1/execute`, {
    method: 'POST', headers,
    body: JSON.stringify({
      teachSessionId: started.session.id,
      action: {
        id: 'teach-read',
        capability: 'file.read',
        risk: 'read',
        input: { path: path.join(root, 'demo.txt') },
        provenance: { kind: 'user' }
      }
    })
  });
  assert.equal(executed.status, 200);

  const inspected = await (await fetch(`${base}/v1/studio/teach/${started.session.id}`, { headers })).json() as any;
  assert.equal(inspected.session.steps.length, 1);
  assert.equal(inspected.session.steps[0].provider, 'teach-api-probe');
  assert.equal(inspected.session.steps[0].capability, 'file.read');

  assert.equal((await fetch(`${base}/v1/studio/teach/${started.session.id}/stop`, { method: 'POST', headers })).status, 200);
  const verificationResponse = await fetch(`${base}/v1/studio/teach/${started.session.id}/verify`, {
    method: 'POST', headers,
    body: JSON.stringify({
      checks: [{
        name: 'demonstrated-read',
        ok: true,
        detail: 'The demonstrated read outcome was independently confirmed.',
        evidenceDigests: [inspected.session.steps[0].evidenceDigest]
      }]
    })
  });
  assert.equal(verificationResponse.status, 200);
  const verification = await verificationResponse.json() as any;
  assert.equal(verification.receipt.verified, true);

  const compiledResponse = await fetch(`${base}/v1/studio/teach/${started.session.id}/compile`, {
    method: 'POST', headers,
    body: JSON.stringify({ verificationReceipt: verification.receipt })
  });
  assert.equal(compiledResponse.status, 200);
  const compiled = await compiledResponse.json() as any;
  assert.equal(compiled.workflow.steps.length, 1);

  const desiredResponse = await fetch(`${base}/v1/desired-state`, {
    method: 'POST', headers,
    body: JSON.stringify({
      name: 'Keep demo healthy',
      scopeKey: 'project:demo',
      desired: [{ entityKey: 'service:demo', factKey: 'health', expectedValueDigest: worldValueDigest('healthy') }],
      remediation: {
        objective: 'Repair demo',
        successConditions: ['demo becomes healthy'],
        authority: { maxRisk: 'read', capabilities: ['file.read'], resources: ['repo:/demo'] }
      },
      policy: { autoRemediate: false }
    })
  });
  assert.equal(desiredResponse.status, 201);
  const desired = await desiredResponse.json() as any;
  assert.equal(desired.contract.status, 'DRIFTED');

  const reconcile = await fetch(`${base}/v1/desired-state/${desired.contract.id}/reconcile`, { method: 'POST', headers });
  assert.equal(reconcile.status, 200);
  assert.equal(operations.submitted.length, 0);
});
