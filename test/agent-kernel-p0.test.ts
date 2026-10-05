import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AgentKernel } from '../src/core/agent-kernel.ts';
import { ActionTransitionJournal } from '../src/core/action-transition-journal.ts';
import { DurableSagaKernel } from '../src/core/durable-saga.ts';
import { kernelVerificationDigest } from '../src/core/action-verification.ts';
import { IntentRegistry, bindingForIntent } from '../src/core/intent-registry.ts';
import { ResourceLeaseStore } from '../src/core/resource-leases.ts';
import { resolvePhysicalResourceKeysForAction } from '../src/core/resource-identity.ts';
import { OperatorRuntime } from '../src/core/runtime.ts';
import { OperatorError } from '../src/core/errors.ts';
import { EnterprisePolicyStore } from '../src/core/enterprise-policy.ts';
import { StudioWorkflowExecutor } from '../src/core/studio-executor.ts';
import { TeachModeStore } from '../src/core/studio-teach.ts';
import { TeamCoordinator } from '../src/core/team-coordinator.ts';
import type {
  ActionRequest,
  ActionResult,
  CapabilityExecutionContext,
  CapabilityProvider,
  CapabilityScore,
  PermissionProfile,
  ProviderReconciliationRequest,
  ProviderReconciliationResult
} from '../src/core/types.ts';

const SCORE: CapabilityScore = {
  reliability: 1,
  latency: 0,
  determinism: 1,
  security: 1,
  reversibility: 1,
  informationQuality: 1,
  interactionCost: 0
};

class StateProvider implements CapabilityProvider {
  readonly name = 'test.state';
  calls = 0;
  reconciliations = 0;
  readonly values = new Map<string, unknown>();

  supports(action: ActionRequest): boolean {
    return ['computer.inspect', 'file.write', 'file.replace'].includes(action.capability);
  }
  score(): CapabilityScore { return SCORE; }
  resolveRisk(action: ActionRequest): ActionRequest['risk'] {
    if (action.capability === 'file.replace') return 'destructive';
    return action.capability === 'computer.inspect' ? 'read' : 'write';
  }

  async execute(action: ActionRequest, _context?: CapabilityExecutionContext): Promise<ActionResult> {
    this.calls += 1;
    const key = String(action.input.key ?? 'default');
    if (action.capability === 'computer.inspect') {
      return success(action, this.name, { key, value: this.values.get(key) ?? null });
    }
    if (action.input.behavior === 'fail') {
      return {
        ok: false,
        capability: action.capability,
        provider: this.name,
        evidence: [{ kind: 'planned_failure', status: 'fail', message: 'Planned definite failure.', timestamp: new Date().toISOString() }],
        error: {
          code: 'PLANNED_FAILURE',
          message: 'Planned definite failure.',
          retryable: false,
          sideEffectState: 'none',
          executionPhase: 'effect_observed'
        },
        durationMs: 0
      };
    }

    this.values.set(key, action.input.value);
    if (action.input.behavior === 'uncertain') {
      return {
        ok: false,
        capability: action.capability,
        provider: this.name,
        evidence: [{ kind: 'transport_loss', status: 'fail', message: 'Transport failed after applying state.', timestamp: new Date().toISOString() }],
        error: {
          code: 'TRANSPORT_LOST',
          message: 'Transport failed after applying state.',
          retryable: false,
          sideEffectState: 'uncertain',
          executionPhase: 'dispatched'
        },
        durationMs: 0
      };
    }
    return success(action, this.name, { key, value: this.values.get(key) });
  }

  async reconcile(request: ProviderReconciliationRequest): Promise<ProviderReconciliationResult> {
    this.reconciliations += 1;
    const key = String(request.action.input.key ?? 'default');
    if (this.values.get(key) !== request.action.input.value) {
      return {
        status: 'not_applied',
        evidence: [{ kind: 'state_reconciliation', status: 'info', message: 'Requested state is not present.', timestamp: new Date().toISOString() }]
      };
    }
    const result = success(request.action, this.name, { key, value: this.values.get(key), reconciled: true });
    return {
      status: 'completed',
      result,
      evidence: [{ kind: 'state_reconciliation', status: 'pass', message: 'Requested state is present.', timestamp: new Date().toISOString() }]
    };
  }
}

function success(action: ActionRequest, provider: string, output: unknown): ActionResult {
  return {
    ok: true,
    capability: action.capability,
    provider,
    output,
    evidence: [{ kind: 'postcondition', status: 'pass', message: 'Requested state is verified.', timestamp: new Date().toISOString() }],
    durationMs: 0
  };
}

function permissions(capabilities: string[], extra: Partial<PermissionProfile> = {}): PermissionProfile {
  return {
    allowedCapabilities: capabilities,
    allowedRoots: [],
    allowExternalWrites: false,
    allowSystemChanges: false,
    allowDestructive: false,
    ...extra
  };
}

async function temp(t: test.TestContext): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-kernel-p0-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function kernelAt(stateDir: string, provider: CapabilityProvider): {
  kernel: AgentKernel;
  runtime: OperatorRuntime;
  journal: ActionTransitionJournal;
  intents: IntentRegistry;
} {
  const runtime = new OperatorRuntime().register(provider);
  const journal = new ActionTransitionJournal(stateDir);
  const intents = new IntentRegistry(stateDir);
  const kernel = new AgentKernel({
    stateDir,
    runtime,
    leases: new ResourceLeaseStore(stateDir),
    journal,
    intents
  });
  return { kernel, runtime, journal, intents };
}

test('shared AgentKernel pre-dispatch guard blocks every provider before journal dispatch', async (t) => {
  const stateDir = await temp(t);
  const provider = new StateProvider();
  const runtime = new OperatorRuntime().register(provider);
  const journal = new ActionTransitionJournal(stateDir);
  const kernel = new AgentKernel({
    stateDir,
    runtime,
    leases: new ResourceLeaseStore(stateDir),
    journal,
    beforeProviderDispatch: async () => {
      throw new OperatorError(
        'EMERGENCY_STOPPED',
        'Emergency stop engaged immediately before provider dispatch.',
        { retryable: false, details: { sideEffectState: 'none', executionPhase: 'pre_dispatch' } }
      );
    }
  });
  const action: ActionRequest = {
    id: 'kernel-pre-dispatch-stop',
    capability: 'file.write',
    risk: 'write',
    input: { path: path.join(os.tmpdir(), 'operator-agent-kernel-resource'), key: 'x', value: 1 },
    provenance: { kind: 'trusted_policy' }
  };

  const result = await kernel.execute(action, permissions(['file.write']));
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'EMERGENCY_STOPPED');
  assert.equal(result.error?.executionPhase, 'pre_dispatch');
  assert.equal(result.error?.sideEffectState, 'none');
  assert.equal(provider.calls, 0);
  assert.equal((await journal.inspect(action.id)).state, 'DEFERRED');
});

test('enterprise policy freshness is revalidated at the shared AgentKernel dispatch boundary', async (t) => {
  const stateDir = await temp(t);
  const root = path.join(stateDir, 'project');
  await fs.mkdir(root, { recursive: true });
  const enterprise = new EnterprisePolicyStore(stateDir);
  const configure = async (caps: string[]) => await enterprise.configure({
    roles: [{
      id: 'developer',
      capabilities: caps,
      rootPrefixes: [root],
      maxRisk: 'write',
      environments: [],
      projectPrefixes: [],
      deviceGroups: []
    }],
    bindings: [{
      id: 'developer-binding',
      principalId: 'alice',
      roleId: 'developer',
      enabled: true
    }]
  });
  await configure(['file.write']);

  const decision = await enterprise.narrow(
    permissions(['file.write'], { allowedRoots: [root], maxRisk: 'write' }),
    { principalId: 'alice' }
  );

  const provider = new StateProvider();
  const runtime = new OperatorRuntime().register(provider);
  const journal = new ActionTransitionJournal(stateDir);
  const kernel = new AgentKernel({
    stateDir,
    runtime,
    leases: new ResourceLeaseStore(stateDir),
    journal,
    beforeProviderDispatch: async (_action, _providerName, actionPermissions) => {
      if (actionPermissions.enterprisePolicyDigest) {
        await enterprise.assertCurrentDigest(actionPermissions.enterprisePolicyDigest);
      }
    }
  });

  await configure(['file.read']);
  const action: ActionRequest = {
    id: 'enterprise-stale-before-dispatch',
    capability: 'file.write',
    risk: 'write',
    input: { path: path.join(root, 'a.txt'), key: 'x', value: 1 },
    provenance: { kind: 'trusted_policy' }
  };
  const result = await kernel.execute(action, decision.permissions);
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'ENTERPRISE_POLICY_STALE');
  assert.equal(result.error?.executionPhase, 'pre_dispatch');
  assert.equal(result.error?.sideEffectState, 'none');
  assert.equal(provider.calls, 0);
  assert.equal((await journal.inspect(action.id)).state, 'DEFERRED');
});

test('newest intent wins before provider dispatch', async (t) => {
  const stateDir = await temp(t);
  const provider = new StateProvider();
  const { kernel, intents } = kernelAt(stateDir, provider);
  const v1 = await intents.update('conversation-1', {
    objective: 'Read x.',
    directive: 'continue',
    sourceTurnId: 'turn-1'
  });
  await intents.update('conversation-1', {
    objective: 'Do not read x anymore.',
    directive: 'redirect',
    sourceTurnId: 'turn-2'
  });
  const result = await kernel.execute({
    id: 'intent-stale-action',
    capability: 'computer.inspect',
    risk: 'read',
    input: { path: path.join(os.tmpdir(), 'operator-agent-kernel-resource'), key: 'x' },
    provenance: { kind: 'trusted_policy' },
    intent: bindingForIntent(v1)
  }, permissions(['computer.inspect']));

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'INTENT_STALE');
  assert.equal(provider.calls, 0);
});

test('approval-required stays deferred and same action id can dispatch after approval', async (t) => {
  const stateDir = await temp(t);
  const provider = new StateProvider();
  const { kernel, journal } = kernelAt(stateDir, provider);
  const action: ActionRequest = {
    id: 'danger-action',
    capability: 'file.replace',
    risk: 'destructive',
    input: { path: path.join(os.tmpdir(), 'operator-agent-kernel-resource'), key: 'danger', value: 1 },
    provenance: { kind: 'trusted_policy' }
  };

  const blocked = await kernel.execute(action, permissions(['file.replace']));
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error?.code, 'APPROVAL_REQUIRED');
  assert.equal(provider.calls, 0);
  assert.equal((await journal.inspect(action.id)).state, 'DEFERRED');

  const completed = await kernel.execute(action, permissions(['file.replace'], {
    approvedActionIds: [action.id]
  }));
  assert.equal(completed.ok, true);
  assert.equal(provider.calls, 1);
  assert.equal(provider.values.get('danger'), 1);
  assert.equal((await journal.inspect(action.id)).state, 'COMPLETED');
});

test('hierarchical resource leases reject parent-child mutation overlap', async (t) => {
  const stateDir = await temp(t);
  const leases = new ResourceLeaseStore(stateDir);
  const parent = await leases.acquire('owner-parent', ['fs-path:/project'], 'exclusive');
  await assert.rejects(
    () => leases.acquire('owner-child', ['fs-path:/project/src/a.ts'], 'exclusive'),
    (error: any) => error?.code === 'RESOURCE_BUSY' && error?.details?.conflictingKey === 'fs-path:/project'
  );
  await parent.release();
  const child = await leases.acquire('owner-child', ['fs-path:/project/src/a.ts'], 'exclusive');
  await child.release();
});

test('uncertain mutation is reconciled by provider and journal completes without replay', async (t) => {
  const stateDir = await temp(t);
  const provider = new StateProvider();
  const { kernel, journal } = kernelAt(stateDir, provider);
  const action: ActionRequest = {
    id: 'uncertain-action',
    capability: 'file.write',
    risk: 'write',
    input: { path: path.join(os.tmpdir(), 'operator-agent-kernel-resource'), key: 'x', value: 42, behavior: 'uncertain' },
    provenance: { kind: 'trusted_policy' }
  };
  const result = await kernel.execute(action, permissions(['file.write']));
  assert.equal(result.ok, true);
  assert.equal(provider.calls, 1);
  assert.equal(provider.reconciliations, 1);
  assert.equal(provider.values.get('x'), 42);
  assert.match(String(result.evidence.find((item) => item.kind === 'kernel_verification')?.data?.verificationDigest), /^[0-9a-f]{64}$/);
  assert.equal((await journal.inspect(action.id)).state, 'COMPLETED');
});

test('durable saga compensates completed mutations after later definite failure', async (t) => {
  const stateDir = await temp(t);
  const provider = new StateProvider();
  const { kernel } = kernelAt(stateDir, provider);
  provider.values.set('x', 0);
  const sagas = new DurableSagaKernel(stateDir, {
    kernel,
    permissions: permissions(['file.write'])
  });
  const saga = await sagas.submit({
    objective: 'Set x, then perform a second operation atomically.',
    steps: [
      {
        key: 'set-x',
        action: {
          id: 'saga-set-x',
          capability: 'file.write',
          risk: 'write',
          input: { path: path.join(os.tmpdir(), 'operator-agent-kernel-resource'), key: 'x', value: 1 },
          provenance: { kind: 'trusted_policy' }
        },
        compensation: {
          id: 'saga-restore-x',
          capability: 'file.write',
          risk: 'write',
          input: { path: path.join(os.tmpdir(), 'operator-agent-kernel-resource'), key: 'x', value: 0 },
          provenance: { kind: 'trusted_policy' }
        }
      },
      {
        key: 'fail-next',
        action: {
          id: 'saga-fail-next',
          capability: 'file.write',
          risk: 'write',
          input: { path: path.join(os.tmpdir(), 'operator-agent-kernel-resource'), key: 'next', behavior: 'fail' },
          provenance: { kind: 'trusted_policy' }
        }
      }
    ]
  });

  const result = await sagas.run(saga.id);
  assert.equal(result.state, 'COMPENSATED');
  assert.equal(provider.values.get('x'), 0);
  assert.equal(result.steps[0]?.state, 'COMPENSATED');
  assert.match(String(result.steps[0]?.compensationVerificationDigest), /^[0-9a-f]{64}$/);
  assert.equal(result.steps[1]?.state, 'FAILED');
});

test('durable saga restart recovers a completed mutation from journal without redispatch', async (t) => {
  const stateDir = await temp(t);
  const provider = new StateProvider();
  const { kernel } = kernelAt(stateDir, provider);
  const sagaKernel = new DurableSagaKernel(stateDir, {
    kernel,
    permissions: permissions(['file.write'])
  });
  const submitted = await sagaKernel.submit({
    objective: 'Persist one mutation.',
    steps: [{
      key: 'set-x',
      action: {
        id: 'saga-restart-set-x',
        capability: 'file.write',
        risk: 'write',
        input: { path: path.join(os.tmpdir(), 'operator-agent-kernel-resource'), key: 'x', value: 7 },
        provenance: { kind: 'trusted_policy' }
      }
    }]
  });

  const executed = await kernel.execute(
    submitted.steps[0]!.action,
    permissions(['file.write']),
    { ownerKind: 'saga', ownerId: submitted.id }
  );
  assert.equal(executed.ok, true);
  assert.equal(provider.calls, 1);

  const sagaFile = path.join(stateDir, 'durable-sagas.json');
  const persisted = JSON.parse(await fs.readFile(sagaFile, 'utf8'));
  persisted.sagas[0].state = 'RUNNING';
  persisted.sagas[0].steps[0].state = 'RUNNING';
  persisted.sagas[0].updatedAt = new Date().toISOString();
  persisted.sagas[0].steps[0].updatedAt = persisted.sagas[0].updatedAt;
  await fs.writeFile(sagaFile, JSON.stringify(persisted, null, 2), 'utf8');

  const restarted = new DurableSagaKernel(stateDir, {
    kernel,
    permissions: permissions(['file.write'])
  });
  const recovered = await restarted.run(submitted.id);
  assert.equal(recovered.state, 'COMPLETED');
  assert.equal(recovered.steps[0]?.state, 'COMPLETED');
  assert.equal(provider.calls, 1, 'completed mutation must not be dispatched twice after restart');
});


test('current cancel intent blocks forward execution before provider dispatch', async (t) => {
  const stateDir = await temp(t);
  const provider = new StateProvider();
  const { kernel, intents } = kernelAt(stateDir, provider);
  const cancelled = await intents.update('conversation-cancel', {
    objective: 'Cancel this work.',
    directive: 'cancel',
    sourceTurnId: 'turn-cancel'
  });
  const result = await kernel.execute({
    id: 'intent-cancel-action',
    capability: 'computer.inspect',
    risk: 'read',
    input: { path: path.join(os.tmpdir(), 'operator-agent-kernel-resource'), key: 'x' },
    provenance: { kind: 'trusted_policy' },
    intent: bindingForIntent(cancelled)
  }, permissions(['computer.inspect']));

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'INTENT_NOT_EXECUTABLE');
  assert.equal(provider.calls, 0);
});

test('stale intent still permits reconciliation of an already-dispatched mutation and publishes observation once', async (t) => {
  const stateDir = await temp(t);
  const provider = new StateProvider();
  const runtime = new OperatorRuntime().register(provider);
  const journal = new ActionTransitionJournal(stateDir);
  const intents = new IntentRegistry(stateDir);
  let observations = 0;
  const kernel = new AgentKernel({
    stateDir,
    runtime,
    leases: new ResourceLeaseStore(stateDir),
    journal,
    intents,
    observeResult: async () => { observations += 1; }
  });
  const v1 = await intents.update('conversation-reconcile', {
    objective: 'Write x.',
    directive: 'continue',
    sourceTurnId: 'turn-1'
  });
  const action: ActionRequest = {
    id: 'stale-reconcile-action',
    capability: 'file.write',
    risk: 'write',
    input: { path: path.join(os.tmpdir(), 'operator-agent-kernel-resource'), key: 'x', value: 42, behavior: 'uncertain' },
    provenance: { kind: 'trusted_policy' },
    intent: bindingForIntent(v1)
  };

  const prior = await provider.execute(action);
  assert.equal(prior.ok, false);
  assert.equal(prior.error?.sideEffectState, 'uncertain');
  await journal.prepare({ action, ownerKind: 'test', ownerId: 'reconcile', resourceKeys: await resolvePhysicalResourceKeysForAction(action) });
  await journal.markDispatched(action.id, provider.name);
  await journal.observe(action.id, prior);

  await intents.update('conversation-reconcile', {
    objective: 'Do something else now.',
    directive: 'redirect',
    sourceTurnId: 'turn-2'
  });

  const reconciled = await kernel.reconcile(action, provider.name, prior);
  assert.equal(reconciled.status, 'completed');
  assert.equal(reconciled.result?.ok, true);
  assert.equal(provider.reconciliations, 1);
  assert.equal(observations, 1);
  assert.equal((await journal.inspect(action.id)).state, 'COMPLETED');
});

test('Team refuses forward scheduling after its durable intent is superseded', async (t) => {
  const stateDir = await temp(t);
  const intents = new IntentRegistry(stateDir);
  const v1 = await intents.update('conversation-team', {
    objective: 'Run the team mission.',
    directive: 'continue',
    sourceTurnId: 'turn-1'
  });
  const teams = new TeamCoordinator(stateDir, { intentRegistry: intents });
  const mission = await teams.submit({
    objective: 'Team mission',
    intent: bindingForIntent(v1),
    workItems: [
      {
        key: 'work',
        title: 'Do work',
        role: 'general',
        risk: 'read',
        allowedCapabilities: []
      },
      {
        key: 'verify',
        title: 'Verify work',
        role: 'verifier',
        risk: 'read',
        dependsOn: ['work'],
        allowedCapabilities: []
      }
    ]
  });

  await intents.update('conversation-team', {
    objective: 'Replace the team mission.',
    directive: 'redirect',
    sourceTurnId: 'turn-2'
  });

  await assert.rejects(
    () => teams.start(mission.id),
    (error: any) => error?.code === 'INTENT_STALE'
  );
});

test('Teach session refuses continuation after its intent is superseded', async (t) => {
  const stateDir = await temp(t);
  const intents = new IntentRegistry(stateDir);
  const v1 = await intents.update('conversation-teach', {
    objective: 'Teach this workflow.',
    directive: 'continue',
    sourceTurnId: 'turn-1'
  });
  const teach = new TeachModeStore(stateDir, { intentRegistry: intents });
  const session = await teach.start({
    title: 'Intent-bound teaching',
    objective: 'Demonstrate one action',
    scopeKey: 'scope:teach',
    intent: bindingForIntent(v1)
  });
  await intents.update('conversation-teach', {
    objective: 'Stop teaching this workflow.',
    directive: 'redirect',
    sourceTurnId: 'turn-2'
  });

  await assert.rejects(
    () => teach.stop(session.id),
    (error: any) => error?.code === 'INTENT_STALE'
  );
});

test('Studio run is cancelled before dispatch when a newer intent supersedes it', async (t) => {
  const stateDir = await temp(t);
  const provider = new StateProvider();
  const { kernel, runtime, intents } = kernelAt(stateDir, provider);
  const teach = new TeachModeStore(stateDir);
  const session = await teach.start({
    title: 'Reusable read',
    objective: 'Inspect one value',
    scopeKey: 'scope:studio'
  });
  const demonstratedAction: ActionRequest = {
    id: 'studio-demo-action',
    capability: 'computer.inspect',
    risk: 'read',
    input: { path: path.join(os.tmpdir(), 'operator-agent-kernel-resource'), key: 'x' },
    provenance: { kind: 'trusted_policy' }
  };
  await teach.record(session.id, {
    action: demonstratedAction,
    result: success(demonstratedAction, provider.name, { key: 'x', value: null })
  });
  await teach.stop(session.id);
  const receipt = await teach.verify(session.id, [{
    name: 'demonstration-reviewed',
    ok: true,
    detail: 'Demonstration is accepted for the Studio lineage regression.'
  }]);
  const workflow = await teach.compile(session.id, { verificationReceipt: receipt });

  const v1 = await intents.update('conversation-studio', {
    objective: 'Run the Studio workflow.',
    directive: 'continue',
    sourceTurnId: 'turn-1'
  });
  const studio = new StudioWorkflowExecutor(stateDir, {
    teach,
    runtime,
    leases: new ResourceLeaseStore(stateDir),
    permissions: permissions(['computer.inspect']),
    agentKernel: kernel,
    intentRegistry: intents
  });
  const run = await studio.submit(workflow.id, {}, undefined, bindingForIntent(v1));
  await intents.update('conversation-studio', {
    objective: 'Do not run that workflow.',
    directive: 'redirect',
    sourceTurnId: 'turn-2'
  });

  const cancelled = await studio.execute(run.id);
  assert.equal(cancelled.state, 'CANCELLED');
  assert.equal(provider.calls, 0);
});

test('superseded saga intent stops new work but still allows compensation of prior effects', async (t) => {
  const stateDir = await temp(t);
  const provider = new StateProvider();
  const { kernel, intents } = kernelAt(stateDir, provider);
  provider.values.set('x', 0);
  const v1 = await intents.update('conversation-saga-intent', {
    objective: 'Perform the two-step change.',
    directive: 'continue',
    sourceTurnId: 'turn-1'
  });
  const sagas = new DurableSagaKernel(stateDir, {
    kernel,
    permissions: permissions(['file.write'])
  });
  const submitted = await sagas.submit({
    objective: 'Change x and then y.',
    intent: bindingForIntent(v1),
    steps: [
      {
        key: 'set-x',
        action: {
          id: 'intent-saga-set-x',
          capability: 'file.write',
          risk: 'write',
          input: { path: path.join(os.tmpdir(), 'operator-agent-kernel-resource'), key: 'x', value: 1 },
          provenance: { kind: 'trusted_policy' }
        },
        compensation: {
          id: 'intent-saga-restore-x',
          capability: 'file.write',
          risk: 'write',
          input: { path: path.join(os.tmpdir(), 'operator-agent-kernel-resource'), key: 'x', value: 0 },
          provenance: { kind: 'trusted_policy' }
        }
      },
      {
        key: 'set-y',
        action: {
          id: 'intent-saga-set-y',
          capability: 'file.write',
          risk: 'write',
          input: { path: path.join(os.tmpdir(), 'operator-agent-kernel-resource'), key: 'y', value: 1 },
          provenance: { kind: 'trusted_policy' }
        }
      }
    ]
  });

  const first = await kernel.execute(
    submitted.steps[0]!.action,
    permissions(['file.write']),
    { ownerKind: 'saga', ownerId: submitted.id }
  );
  assert.equal(first.ok, true);
  const firstDigest = kernelVerificationDigest(first);
  assert.match(String(firstDigest), /^[0-9a-f]{64}$/);

  const sagaFile = path.join(stateDir, 'durable-sagas.json');
  const persisted = JSON.parse(await fs.readFile(sagaFile, 'utf8'));
  const now = new Date().toISOString();
  persisted.sagas[0].state = 'RUNNING';
  persisted.sagas[0].updatedAt = now;
  persisted.sagas[0].steps[0].state = 'COMPLETED';
  persisted.sagas[0].steps[0].provider = provider.name;
  persisted.sagas[0].steps[0].verificationDigest = firstDigest;
  persisted.sagas[0].steps[0].updatedAt = now;
  await fs.writeFile(sagaFile, JSON.stringify(persisted, null, 2), 'utf8');

  await intents.update('conversation-saga-intent', {
    objective: 'Cancel the old plan and use a new direction.',
    directive: 'redirect',
    sourceTurnId: 'turn-2'
  });

  const finished = await sagas.run(submitted.id);
  assert.equal(finished.state, 'COMPENSATED');
  assert.equal(finished.steps[0]?.state, 'COMPENSATED');
  assert.equal(finished.steps[1]?.state, 'FAILED');
  assert.equal(finished.steps[1]?.errorCode, 'INTENT_STALE');
  assert.equal(provider.values.get('x'), 0);
  assert.equal(provider.values.has('y'), false);
  assert.equal(provider.calls, 2, 'only original mutation and compensation should dispatch');
});


test('completed mutation result replays from the central journal without provider redispatch', async (t) => {
  const stateDir = await temp(t);
  const provider = new StateProvider();
  const { kernel, journal } = kernelAt(stateDir, provider);
  const action: ActionRequest = {
    id: 'journal-replay-mutation',
    capability: 'file.write',
    risk: 'write',
    input: { path: path.join(os.tmpdir(), 'operator-agent-kernel-resource'), key: 'x', value: 91 },
    provenance: { kind: 'trusted_policy' }
  };

  const first = await kernel.execute(action, permissions(['file.write']));
  assert.equal(first.ok, true);
  assert.equal(provider.calls, 1);
  assert.equal((await journal.inspect(action.id)).state, 'COMPLETED');

  const replayed = await kernel.execute(action, permissions(['file.write']));
  assert.equal(replayed.ok, true);
  assert.equal(provider.calls, 1, 'completed mutation must never redispatch');
  assert.equal(provider.values.get('x'), 91);
  assert.equal(replayed.evidence.some((item) => item.kind === 'action_journal_replay'), true);
});

test('detached dispatched mutation reconciles to completed without provider replay', async (t) => {
  const stateDir = await temp(t);
  const provider = new StateProvider();
  const { kernel, journal } = kernelAt(stateDir, provider);
  const action: ActionRequest = {
    id: 'journal-dispatched-reconcile',
    capability: 'file.write',
    risk: 'write',
    input: { path: path.join(os.tmpdir(), 'operator-agent-kernel-resource'), key: 'x', value: 77 },
    provenance: { kind: 'trusted_policy' }
  };

  await journal.prepare({ action, ownerKind: 'direct', ownerId: action.id, resourceKeys: await resolvePhysicalResourceKeysForAction(action) });
  await journal.markDispatched(action.id, provider.name);
  provider.values.set('x', 77);

  const recovered = await kernel.execute(action, permissions(['file.write']));
  assert.equal(recovered.ok, true);
  assert.equal(provider.calls, 0, 'reconciliation must recover the prior effect without another execute call');
  assert.equal(provider.reconciliations, 1);
  assert.equal((await journal.inspect(action.id)).state, 'COMPLETED');
});

test('reconciled not-applied mutation may dispatch exactly once after crash recovery', async (t) => {
  const stateDir = await temp(t);
  const provider = new StateProvider();
  const { kernel, journal } = kernelAt(stateDir, provider);
  const action: ActionRequest = {
    id: 'journal-not-applied-retry',
    capability: 'file.write',
    risk: 'write',
    input: { path: path.join(os.tmpdir(), 'operator-agent-kernel-resource'), key: 'x', value: 13 },
    provenance: { kind: 'trusted_policy' }
  };

  await journal.prepare({ action, ownerKind: 'direct', ownerId: action.id, resourceKeys: await resolvePhysicalResourceKeysForAction(action) });
  await journal.markDispatched(action.id, provider.name);

  const recovered = await kernel.execute(action, permissions(['file.write']));
  assert.equal(recovered.ok, true);
  assert.equal(provider.reconciliations, 1);
  assert.equal(provider.calls, 1, 'only a proven not-applied action may be freshly dispatched');
  assert.equal(provider.values.get('x'), 13);
  assert.equal((await journal.inspect(action.id)).state, 'COMPLETED');
});
