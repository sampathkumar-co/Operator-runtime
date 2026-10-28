import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AgentKernel } from '../src/core/agent-kernel.ts';
import { InMemoryCorrelatedOutcomeServer } from '../src/core/correlated-server-outcome.ts';
import { createOutcomeContract, OutcomeReceiptReplayLedger } from '../src/core/outcome-contract.ts';
import { ResourceLeaseStore } from '../src/core/resource-leases.ts';
import { OperatorRuntime } from '../src/core/runtime.ts';
import { TaskOrchestrator, type TaskOutcomeProofPolicy } from '../src/core/task-orchestrator.ts';
import { TaskStore } from '../src/core/task-store.ts';
import type {
  ActionRequest, ActionResult, CapabilityProvider, CapabilityScore, PermissionProfile,
  ProviderReconciliationRequest, ProviderReconciliationResult
} from '../src/core/types.ts';
import { CorrelatedServerOutcomeObserver } from '../src/core/correlated-server-outcome.ts';

const SCORE: CapabilityScore = {
  reliability: 1, latency: 1, determinism: 1, security: 1,
  reversibility: 1, informationQuality: 1, interactionCost: 0
};
const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

async function tempDir(t: test.TestContext, prefix: string): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function passEvidence(kind: string) {
  return [{ kind, status: 'pass' as const, message: 'Synthetic provider state was recorded.', timestamp: new Date().toISOString() }];
}

class CorrelatedBrowserProvider implements CapabilityProvider {
  readonly name = 'synthetic.browser-provider';
  readonly nonce = `nonce-${crypto.randomUUID()}`;
  readonly resourceId = `checkout-${crypto.randomUUID()}`;
  readonly payloadHash: string;
  readonly server: InMemoryCorrelatedOutcomeServer;
  #url = 'https://example.test/start';

  constructor(server: InMemoryCorrelatedOutcomeServer, destination: string) {
    this.server = server;
    this.payloadHash = hash(destination);
  }
  supports(action: ActionRequest): boolean { return ['browser.inspect', 'browser.navigate'].includes(action.capability); }
  score(): CapabilityScore { return SCORE; }
  resolveRisk(action: ActionRequest): ActionRequest['risk'] { return action.capability === 'browser.inspect' ? 'read' : 'write'; }
  async execute(action: ActionRequest): Promise<ActionResult> {
    if (action.capability === 'browser.navigate') {
      this.#url = String(action.input.url);
      this.server.commit({
        kind: 'checkout', resourceId: this.resourceId, actionId: action.id,
        resourceGeneration: 1, nonce: this.nonce, payloadHash: this.payloadHash
      });
      return { ok: true, capability: action.capability, provider: this.name,
        output: { targetId: 'tab-1', url: this.#url, title: 'Synthetic checkout' },
        evidence: passEvidence('synthetic_server_commit'), durationMs: 0 };
    }
    return { ok: true, capability: action.capability, provider: this.name,
      output: action.input.targetId
        ? { target: { id: 'tab-1', type: 'page', title: 'Synthetic checkout', url: this.#url }, page: { semantic: { headings: ['Checkout'] } } }
        : { tabs: [{ id: 'tab-1', type: 'page', title: 'Start', url: this.#url }] },
      evidence: passEvidence('synthetic_browser_observation'), durationMs: 0 };
  }
  async reconcile(request: ProviderReconciliationRequest): Promise<ProviderReconciliationResult> {
    const applied = request.action.capability === 'browser.navigate' && String(request.action.input.url) === this.#url;
    return { status: applied ? 'completed' : 'not_applied',
      ...(applied ? { result: await this.execute({ ...request.action, capability: 'browser.inspect', risk: 'read', input: { targetId: 'tab-1' } }) } : {}),
      evidence: passEvidence('synthetic_browser_reconciliation') };
  }
}

type ProofMode = 'valid' | 'missing' | 'forged' | 'stale' | 'replayed';

async function runStrictBrowserTask(t: test.TestContext, mode: ProofMode) {
  const state = await tempDir(t, `wave2-proof-${mode}-`);
  const destination = 'https://example.test/checkout/confirmed';
  const server = new InMemoryCorrelatedOutcomeServer();
  const provider = new CorrelatedBrowserProvider(server, destination);
  const runtime = new OperatorRuntime().register(provider);
  const kernel = new AgentKernel({ stateDir: state, runtime, leases: new ResourceLeaseStore(state) });
  const keys = crypto.generateKeyPairSync('ed25519');
  const observer = new CorrelatedServerOutcomeObserver({
    server, providerId: provider.name, observerId: 'trusted.server-observer',
    sign: async payload => crypto.sign(null, payload, keys.privateKey).toString('base64')
  });
  const replay = new OutcomeReceiptReplayLedger(state);
  let proofNow: string | undefined;
  const policy: TaskOutcomeProofPolicy = {
    requirements: [{
      goalKind: 'browser-navigation', domain: 'browser', principalId: 'principal-test',
      deviceId: 'device-test', trustedObserverIds: ['trusted.server-observer']
    }],
    async obtainProof({ task, binding }) {
      if (mode === 'missing') return undefined;
      const action = task.execution!.records.find(item => item.actionId === binding.actionId)!;
      const observed = server.observe(provider.resourceId)!;
      const issuedAt = new Date(Date.parse(action.startedAt) - 1).toISOString();
      const expiresAt = new Date(Date.parse(observed.committedAt) + 120_000).toISOString();
      const contract = createOutcomeContract({
        contractId: `contract-${task.id}`, domain: binding.domain,
        actionId: binding.actionId, actionDigest: binding.actionDigest,
        planId: binding.planId, planGeneration: binding.planGeneration,
        actionGeneration: binding.actionGeneration, principalId: 'principal-test', deviceId: 'device-test',
        expectations: [
          { id: 'server-state-correlated', description: 'Server state is correlated to the dispatched action.', required: true },
          { id: 'expected-content-hashes', description: 'Server hashes match the requested synthetic outcome.', required: true },
          { id: 'server-receipt-artifact', description: 'An immutable server receipt artifact exists.', required: true }
        ],
        maxObservationAgeMs: 1_000, issuedAt, expiresAt
      });
      let receipt = await observer.issueReceipt({
        contract, dispatchedAt: action.startedAt, observedAt: observed.committedAt,
        expectation: { resourceId: provider.resourceId, resourceGeneration: 1, nonce: provider.nonce, payloadHash: provider.payloadHash }
      });
      proofNow = mode === 'stale'
        ? new Date(Date.parse(observed.committedAt) + 2_000).toISOString()
        : new Date(Date.parse(observed.committedAt) + 10).toISOString();
      if (mode === 'forged') receipt = { ...receipt, signature: Buffer.from('forged-signature-that-is-long-enough-to-parse').toString('base64') };
      if (mode === 'replayed') await replay.consume(receipt);
      return { contract, receipt };
    },
    verifySignature(observerId, payload, signature) {
      return observerId === 'trusted.server-observer' &&
        crypto.verify(null, payload, keys.publicKey, Buffer.from(signature, 'base64'));
    },
    consumeReceipt: receipt => replay.consume(receipt),
    now: () => proofNow ?? new Date().toISOString()
  };
  const permissions: PermissionProfile = {
    allowedCapabilities: ['browser.inspect', 'browser.navigate'], allowedRoots: [],
    allowDestructive: false, allowExternalWrites: false, allowSystemChanges: false
  };
  const orchestrator = new TaskOrchestrator({
    runtime, store: new TaskStore(state), permissions, outcomeProofPolicy: policy,
    executeAction: (action, granted, context) => kernel.execute(action, granted, context)
  });
  const task = await orchestrator.submit({
    objective: 'Complete a synthetic correlated checkout without a live payment.',
    authorizedScope: ['browser:https://example.test'],
    successConditions: ['server-authoritative synthetic checkout state is independently verified'],
    goal: { kind: 'browser-navigation', url: destination }
  });
  return await orchestrator.run(task.id);
}

test('C07-03 strict proof traverses TaskOrchestrator, TaskVerifier, VerificationKernel and AgentKernel', async t => {
  const completed = await runStrictBrowserTask(t, 'valid');
  assert.equal(completed.state, 'VERIFIED');
  const verification = completed.evidence.find(item => item.kind === 'independent_task_verification');
  assert.equal(verification?.status, 'pass');
  assert.equal((verification?.data?.checks as Array<{ name: string; ok: boolean }>).find(item =>
    item.name === 'required-independent-outcome-proof')?.ok, true);
  assert.match(String((verification?.data?.outcomeProof as { receiptDigest?: string })?.receiptDigest), /^[0-9a-f]{64}$/);
  assert.ok(completed.execution?.records.every(item => item.evidence.some(e => e.kind === 'kernel_verification' && e.status === 'pass')));
});
for (const mode of ['missing', 'forged', 'stale', 'replayed'] as const) {
  test(`C07-03 ${mode} required proof can never produce VERIFIED`, async t => {
    const completed = await runStrictBrowserTask(t, mode);
    assert.equal(completed.state, 'FAILED');
    assert.ok(completed.failures.some(item => mode === 'replayed'
      ? item.code === 'TASK_OUTCOME_PROOF_REPLAY'
      : item.code === 'TASK_INDEPENDENT_VERIFICATION_FAILED'));
    assert.equal(completed.evidence.some(item => item.kind === 'independent_task_verification' && item.status === 'pass'), false);
  });
}

test('C07-03 proof policy rejects ambiguous or cross-domain registrations at startup', async t => {
  const state = await tempDir(t, 'wave2-proof-policy-invalid-');
  const callbacks = {
    async obtainProof() { return undefined; },
    verifySignature() { return false; },
    async consumeReceipt() {}
  };
  assert.throws(() => new TaskOrchestrator({
    runtime: new OperatorRuntime(), store: new TaskStore(state),
    permissions: { allowedCapabilities: [], allowedRoots: [] },
    outcomeProofPolicy: {
      requirements: [{ goalKind: 'browser-navigation', domain: 'download', principalId: 'principal', deviceId: 'device', trustedObserverIds: ['observer'] }],
      ...callbacks
    }
  }), (error: any) => error?.code === 'TASK_OUTCOME_PROOF_POLICY_INVALID');
  assert.throws(() => new TaskOrchestrator({
    runtime: new OperatorRuntime(), store: new TaskStore(state),
    permissions: { allowedCapabilities: [], allowedRoots: [] },
    outcomeProofPolicy: {
      requirements: [
        { goalKind: 'browser-navigation', domain: 'browser', principalId: 'principal', deviceId: 'device', trustedObserverIds: ['observer-1'] },
        { goalKind: 'browser-navigation', domain: 'browser', principalId: 'principal', deviceId: 'device', trustedObserverIds: ['observer-2'] }
      ],
      ...callbacks
    }
  }), (error: any) => error?.code === 'TASK_OUTCOME_PROOF_POLICY_INVALID');
});
