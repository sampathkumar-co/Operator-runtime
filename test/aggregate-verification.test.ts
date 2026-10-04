import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ActionTransitionJournal } from '../src/core/action-transition-journal.ts';
import { AgentKernel } from '../src/core/agent-kernel.ts';
import { ResourceLeaseStore } from '../src/core/resource-leases.ts';
import { OperatorRuntime } from '../src/core/runtime.ts';
import { StudioWorkflowExecutor } from '../src/core/studio-executor.ts';
import { TeachModeStore } from '../src/core/studio-teach.ts';
import { TeamCoordinator } from '../src/core/team-coordinator.ts';
import type { ActionRequest, ActionResult, CapabilityProvider, CapabilityScore, PermissionProfile, ProviderReconciliationResult } from '../src/core/types.ts';

const SCORE: CapabilityScore = {
  reliability: 1, latency: 0, determinism: 1, security: 1,
  reversibility: 1, informationQuality: 1, interactionCost: 0
};

class AggregateProbeProvider implements CapabilityProvider {
  readonly name = 'aggregate-probe';
  state = 'wrong';
  mutationMode: 'success' | 'uncertain' = 'success';
  supports(action: ActionRequest): boolean {
    return action.capability === 'computer.inspect' || action.capability === 'file.write';
  }
  score(): CapabilityScore { return SCORE; }
  async execute(action: ActionRequest): Promise<ActionResult> {
    if (action.capability === 'file.write' && this.mutationMode === 'uncertain') {
      return {
        ok: false, capability: action.capability, provider: this.name,
        evidence: [{ kind: 'provider', status: 'fail', message: 'Response lost after dispatch.', timestamp: new Date().toISOString() }],
        error: { code: 'RESPONSE_LOST', message: 'Response lost after dispatch.', sideEffectState: 'uncertain', executionPhase: 'dispatched' },
        durationMs: 1
      };
    }
    return {
      ok: true, capability: action.capability, provider: this.name,
      output: { state: this.state },
      evidence: [{ kind: 'provider', status: 'pass', message: 'Fresh state observed.', timestamp: new Date().toISOString() }],
      durationMs: 1
    };
  }
  async reconcile(): Promise<ProviderReconciliationResult> {
    return {
      status: 'uncertain',
      evidence: [{ kind: 'provider_reconciliation', status: 'info', message: 'Provider cannot prove the mutation effect.', timestamp: new Date().toISOString() }]
    };
  }
}

async function fixture(t: test.TestContext) {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-aggregate-truth-state-'));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-aggregate-truth-root-'));
  t.after(() => Promise.all([
    fs.rm(state, { recursive: true, force: true }),
    fs.rm(root, { recursive: true, force: true })
  ]));
  const provider = new AggregateProbeProvider();
  const runtime = new OperatorRuntime().register(provider);
  t.after(() => runtime.close());
  const journal = new ActionTransitionJournal(state);
  const kernel = new AgentKernel({
    stateDir: state,
    runtime,
    leases: new ResourceLeaseStore(state),
    journal
  });
  const permissions: PermissionProfile = {
    allowedCapabilities: ['computer.inspect', 'file.write'],
    allowedRoots: [root]
  };
  const teach = new TeachModeStore(state, {
    journal,
    requireKernelVerification: true,
    agentKernel: kernel,
    permissions
  });
  return { state, root, provider, runtime, journal, kernel, permissions, teach };
}

function verification(expected: string) {
  return {
    probes: [{
      name: 'semantic-outcome',
      capability: 'computer.inspect',
      input: {},
      assertions: [{ path: 'state', operator: 'equals', value: expected }]
    }]
  };
}

async function teachReadWorkflow(f: Awaited<ReturnType<typeof fixture>>) {
  const session = await f.teach.start({ title: 'Read state', objective: 'Reach the required state', scopeKey: 'system:local' });
  const action: ActionRequest = {
    id: 'teach-read-state', capability: 'computer.inspect', risk: 'read', input: {}, provenance: { kind: 'user' }
  };
  const result = await f.kernel.execute(action, f.permissions, { ownerKind: 'teach', ownerId: session.id });
  await f.teach.record(session.id, { action, result });
  await f.teach.stop(session.id);
  const receipt = await f.teach.verify(session.id, verification('wrong'));
  return await f.teach.compile(session.id, { verificationReceipt: receipt });
}

test('Studio cannot turn caller-authored ok=true into aggregate verification', async (t) => {
  const f = await fixture(t);
  const workflow = await teachReadWorkflow(f);
  const executor = new StudioWorkflowExecutor(f.state, {
    teach: f.teach, runtime: f.runtime, leases: new ResourceLeaseStore(f.state),
    permissions: f.permissions, agentKernel: f.kernel
  });
  const submitted = await executor.submit(workflow.id, {});
  const ready = await executor.execute(submitted.id);
  assert.equal(ready.state, 'AWAITING_VERIFICATION');
  await assert.rejects(
    () => executor.verify(ready.id, [{ name: 'caller-says-pass', ok: true, detail: 'trust me' }]),
    (error: any) => error?.code === 'CANONICAL_VERIFICATION_INVALID'
  );
  const failed = await executor.verify(ready.id, verification('right'));
  assert.equal(failed.state, 'FAILED');
  assert.equal(failed.verificationReceipt?.verified, false);
});

test('Teach cannot compile solely from caller-authored verification truth', async (t) => {
  const f = await fixture(t);
  const session = await f.teach.start({ title: 'Unsafe claim', objective: 'Prove right state', scopeKey: 'system:local' });
  const action: ActionRequest = {
    id: 'teach-claim-state', capability: 'computer.inspect', risk: 'read', input: {}, provenance: { kind: 'user' }
  };
  await f.teach.record(session.id, { action, result: await f.kernel.execute(action, f.permissions, { ownerKind: 'teach', ownerId: session.id }) });
  await f.teach.stop(session.id);
  await assert.rejects(
    () => f.teach.verify(session.id, [{ name: 'caller-says-pass', ok: true, detail: 'trust me' }]),
    (error: any) => error?.code === 'CANONICAL_VERIFICATION_INVALID'
  );
  const receipt = await f.teach.verify(session.id, verification('right'));
  assert.equal(receipt.verified, false);
  await assert.rejects(
    () => f.teach.compile(session.id, { verificationReceipt: receipt }),
    (error: any) => error?.code === 'TEACH_VERIFICATION_REQUIRED'
  );
});

test('Studio uncertain mutation remains blocked when caller requests completed but provider state is uncertain', async (t) => {
  const f = await fixture(t);
  const file = path.join(f.root, 'target.txt');
  await fs.writeFile(file, 'before', 'utf8');
  const session = await f.teach.start({ title: 'Write state', objective: 'Write target', scopeKey: 'project:test' });
  const action: ActionRequest = {
    id: 'teach-write-state', capability: 'file.write', risk: 'write',
    input: { path: file, content: 'after' }, provenance: { kind: 'user' }
  };
  await f.teach.record(session.id, { action, result: await f.kernel.execute(action, f.permissions, { ownerKind: 'teach', ownerId: session.id }) });
  await f.teach.stop(session.id);
  const receipt = await f.teach.verify(session.id, verification('wrong'));
  const workflow = await f.teach.compile(session.id, { verificationReceipt: receipt });
  f.provider.mutationMode = 'uncertain';
  const executor = new StudioWorkflowExecutor(f.state, {
    teach: f.teach, runtime: f.runtime, leases: new ResourceLeaseStore(f.state),
    permissions: f.permissions, agentKernel: f.kernel
  });
  const run = await executor.submit(workflow.id, {});
  const blocked = await executor.execute(run.id);
  assert.equal(blocked.state, 'BLOCKED');
  await assert.rejects(
    () => executor.reconcile(run.id, blocked.steps[0]!.key, {
      resolution: 'completed', checks: [{ name: 'caller-says-completed', ok: true, detail: 'trust me' }]
    }),
    (error: any) => error?.code === 'STUDIO_RECONCILIATION_UNVERIFIED'
  );
  assert.equal((await executor.inspect(run.id)).steps[0]?.state, 'NEEDS_RECONCILIATION');
});

test('production Team verification requires its own durable read observation and caller summaries cannot clear uncertainty', async (t) => {
  const f = await fixture(t);
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-team-aggregate-truth-'));
  t.after(() => fs.rm(state, { recursive: true, force: true }));
  const teams = new TeamCoordinator(state, { requireKernelVerification: true });
  const mission = await teams.submit({
    objective: 'Do one mutation and verify it',
    workItems: [
      { key: 'mutate', title: 'Mutate', role: 'coder', risk: 'write', resources: ['file:one'] },
      { key: 'verify', title: 'Verify', role: 'verifier', risk: 'read', dependsOn: ['mutate'] }
    ]
  });
  await teams.start(mission.id);
  const coder = (await teams.registerWorker(mission.id, { role: 'coder', label: 'coder' })).worker;
  await teams.registerWorker(mission.id, { role: 'verifier', label: 'verifier' });
  const supervisor = (await teams.registerWorker(mission.id, { role: 'supervisor', label: 'supervisor' })).worker;
  const mutation = (await teams.claim(mission.id, { workerId: coder.id })).workItem!;
  await teams.fail(mission.id, {
    workerId: coder.id, workItemId: mutation.id, leaseId: mutation.lease!.id,
    code: 'LOST_RESPONSE', message: 'Mutation result lost.', sideEffectState: 'uncertain'
  });
  await assert.rejects(
    () => teams.reconcile(mission.id, {
      workerId: supervisor.id, workItemId: mutation.id, resolution: 'completed',
      summary: 'Caller claims completion.', evidence: [{ kind: 'claim', status: 'pass', message: 'claimed' }]
    }),
    (error: any) => error?.code === 'TEAM_CANONICAL_RECONCILIATION_REQUIRED'
  );
  const stillBlocked = await teams.inspect(mission.id);
  assert.equal(stillBlocked.state, 'BLOCKED');
  assert.equal(stillBlocked.resources[0]?.uncertain, true);

  const separateState = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-team-verifier-truth-'));
  t.after(() => fs.rm(separateState, { recursive: true, force: true }));
  const separate = new TeamCoordinator(separateState, {
    requireKernelVerification: true,
    agentKernel: f.kernel,
    permissions: f.permissions
  });
  const second = await separate.submit({ objective: 'Verify from observation', workItems: [{ key: 'verify', title: 'Verify', role: 'verifier' }] });
  await separate.start(second.id);
  const zeroObservationVerifier = (await separate.registerWorker(second.id, { role: 'verifier', label: 'verifier' })).worker;
  const claim = (await separate.claim(second.id, { workerId: zeroObservationVerifier.id })).workItem!;
  await assert.rejects(
    () => separate.complete(second.id, {
      workerId: zeroObservationVerifier.id, workItemId: claim.id, leaseId: claim.lease!.id,
      summary: 'Caller says verified.', verificationPassed: true
    }),
    (error: any) => error?.code === 'CANONICAL_VERIFICATION_INVALID'
  );
  await assert.rejects(
    () => separate.complete(second.id, {
      workerId: zeroObservationVerifier.id, workItemId: claim.id, leaseId: claim.lease!.id,
      summary: 'Fresh probe must decide.', verificationPassed: true, verification: verification('right')
    }),
    (error: any) => error?.code === 'TEAM_VERIFICATION_REQUIRED'
  );
});
