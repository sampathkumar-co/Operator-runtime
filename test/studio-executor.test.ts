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

const SCORE: CapabilityScore = {
  reliability: 1, latency: 0, determinism: 1, security: 1,
  reversibility: 1, informationQuality: 1, interactionCost: 0
};

class StudioProbeProvider implements CapabilityProvider {
  readonly name = 'studio-probe';
  mode: 'success' | 'uncertain' = 'success';
  calls = 0;
  supports(action: ActionRequest): boolean { return action.capability === 'file.read' || action.capability === 'file.write'; }
  score(): CapabilityScore { return SCORE; }
  async execute(action: ActionRequest): Promise<ActionResult> {
    this.calls += 1;
    if (this.mode === 'uncertain') {
      return {
        ok: false,
        capability: action.capability,
        provider: this.name,
        evidence: [{ kind: 'probe', status: 'fail', message: 'connection lost after dispatch', timestamp: new Date().toISOString() }],
        error: { code: 'PROBE_DISCONNECT', message: 'connection lost after dispatch', retryable: true, sideEffectState: 'uncertain' },
        durationMs: 1
      };
    }
    return {
      ok: true,
      capability: action.capability,
      provider: this.name,
      output: { ok: true },
      evidence: [{ kind: 'probe', status: 'pass', message: 'executed', timestamp: new Date().toISOString() }],
      durationMs: 1
    };
  }
}

async function temp(t: test.TestContext, prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function compiledWorkflow(teach: TeachModeStore, input: { capability: 'file.read' | 'file.write'; risk: 'read' | 'write'; file: string }) {
  const session = await teach.start({
    title: 'Certified workflow',
    objective: 'Perform one semantic file action',
    scopeKey: 'project:studio'
  });
  await teach.record(session.id, {
    action: {
      id: 'demo',
      capability: input.capability,
      risk: input.risk,
      input: { path: input.file },
      provenance: { kind: 'user' }
    },
    result: {
      ok: true,
      capability: input.capability,
      provider: 'demo-provider',
      evidence: [{ kind: 'demo', status: 'pass', message: 'demonstrated successfully', timestamp: new Date().toISOString() }],
      durationMs: 1
    }
  });
  await teach.stop(session.id);
  const receipt = await teach.verify(session.id, [{
    name: 'demonstration-outcome',
    ok: true,
    detail: 'Independent check confirms the demonstrated outcome.',
    evidenceDigests: []
  }]);
  return await teach.compile(session.id, { verificationReceipt: receipt });
}

test('stage19 durable executor never marks successful replay verified before independent verification', async (t) => {
  const state = await temp(t, 'operator-studio-exec-state-');
  const root = await temp(t, 'operator-studio-exec-root-');
  const file = path.join(root, 'a.txt');
  const teach = new TeachModeStore(state);
  const workflow = await compiledWorkflow(teach, { capability: 'file.read', risk: 'read', file });
  const provider = new StudioProbeProvider();
  const runtime = new OperatorRuntime().register(provider);
  t.after(() => runtime.close());
  const executor = new StudioWorkflowExecutor(state, {
    teach,
    runtime,
    leases: new ResourceLeaseStore(state),
    permissions: { allowedCapabilities: ['file.read'], allowedRoots: [root] }
  });

  const submitted = await executor.submit(workflow.id, {});
  const completed = await executor.execute(submitted.id);
  assert.equal(completed.state, 'AWAITING_VERIFICATION');
  assert.equal(completed.steps[0]!.state, 'SUCCEEDED');
  assert.equal(provider.calls, 1);

  const verified = await executor.verify(submitted.id, [{
    name: 'current-outcome',
    ok: true,
    detail: 'Independent verifier confirmed the current workflow outcome.',
    evidenceDigests: [completed.steps[0]!.evidenceDigest!]
  }]);
  assert.equal(verified.state, 'VERIFIED');
  assert.equal(verified.verificationReceipt?.verified, true);
});

test('stage19 workflow replay remains subject to current runtime authority', async (t) => {
  const state = await temp(t, 'operator-studio-auth-state-');
  const root = await temp(t, 'operator-studio-auth-root-');
  const outside = path.resolve(root, '..', 'operator-studio-outside', 'a.txt');
  const teach = new TeachModeStore(state);
  const workflow = await compiledWorkflow(teach, { capability: 'file.read', risk: 'read', file: outside });
  const provider = new StudioProbeProvider();
  const runtime = new OperatorRuntime().register(provider);
  t.after(() => runtime.close());
  const executor = new StudioWorkflowExecutor(state, {
    teach,
    runtime,
    leases: new ResourceLeaseStore(state),
    permissions: { allowedCapabilities: ['file.read'], allowedRoots: [root] }
  });

  const run = await executor.submit(workflow.id, {});
  const failed = await executor.execute(run.id);
  assert.equal(failed.state, 'FAILED');
  assert.equal(failed.steps[0]!.errorCode, 'PATH_OUTSIDE_SCOPE');
  assert.equal(provider.calls, 0);
});

test('stage19 uncertain mutation blocks replay until explicit verified reconciliation', async (t) => {
  const state = await temp(t, 'operator-studio-reconcile-state-');
  const root = await temp(t, 'operator-studio-reconcile-root-');
  const file = path.join(root, 'a.txt');
  const teach = new TeachModeStore(state);
  const workflow = await compiledWorkflow(teach, { capability: 'file.write', risk: 'write', file });
  const provider = new StudioProbeProvider();
  provider.mode = 'uncertain';
  const runtime = new OperatorRuntime().register(provider);
  t.after(() => runtime.close());
  const executor = new StudioWorkflowExecutor(state, {
    teach,
    runtime,
    leases: new ResourceLeaseStore(state),
    permissions: { allowedCapabilities: ['file.write'], allowedRoots: [root] }
  });

  const run = await executor.submit(workflow.id, {});
  const blocked = await executor.execute(run.id);
  assert.equal(blocked.state, 'BLOCKED');
  assert.equal(blocked.steps[0]!.state, 'NEEDS_RECONCILIATION');
  assert.equal(blocked.steps[0]!.sideEffectState, 'uncertain');
  assert.equal(provider.calls, 1);

  await assert.rejects(
    () => executor.execute(run.id),
    (error: any) => error?.code === 'STUDIO_RUN_RECONCILIATION_REQUIRED'
  );
  assert.equal(provider.calls, 1);

  const pending = await executor.reconcile(run.id, blocked.steps[0]!.key, {
    resolution: 'retry',
    checks: [{
      name: 'effect-absent',
      ok: true,
      detail: 'Independent state inspection confirms the attempted mutation did not take effect.',
      evidenceDigests: []
    }]
  });
  assert.equal(pending.state, 'PENDING');
  assert.equal(pending.steps[0]!.state, 'PENDING');

  provider.mode = 'success';
  const completed = await executor.execute(run.id);
  assert.equal(completed.state, 'AWAITING_VERIFICATION');
  assert.equal(provider.calls, 2);
});

test('stage19 failed final verification cannot be upgraded by replaying execution', async (t) => {
  const state = await temp(t, 'operator-studio-verify-state-');
  const root = await temp(t, 'operator-studio-verify-root-');
  const teach = new TeachModeStore(state);
  const workflow = await compiledWorkflow(teach, { capability: 'file.read', risk: 'read', file: path.join(root, 'a.txt') });
  const provider = new StudioProbeProvider();
  const runtime = new OperatorRuntime().register(provider);
  t.after(() => runtime.close());
  const executor = new StudioWorkflowExecutor(state, {
    teach,
    runtime,
    leases: new ResourceLeaseStore(state),
    permissions: { allowedCapabilities: ['file.read'], allowedRoots: [root] }
  });
  const run = await executor.submit(workflow.id, {});
  await executor.execute(run.id);
  const failed = await executor.verify(run.id, [{
    name: 'outcome',
    ok: false,
    detail: 'Independent verification did not observe the required result.',
    evidenceDigests: []
  }]);
  assert.equal(failed.state, 'FAILED');
  await assert.rejects(() => executor.execute(run.id), (error: any) => error?.code === 'STUDIO_RUN_TERMINAL');
});
