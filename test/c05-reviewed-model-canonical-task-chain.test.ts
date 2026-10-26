import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BoundedModelGoalInference } from '../src/core/bounded-model-goal-inference.ts';
import { TrustedReviewedModelTaskIntake } from '../src/core/trusted-reviewed-model-task-intake.ts';
import { TaskOrchestrator } from '../src/core/task-orchestrator.ts';
import { OperatorRuntime } from '../src/core/runtime.ts';
import { TaskStore } from '../src/core/task-store.ts';
import type {
  ActionRequest, ActionResult, CapabilityProvider, CapabilityScore
} from '../src/core/types.ts';

const SCORE: CapabilityScore = {
  reliability: 1, latency: 1, determinism: 1, security: 1,
  reversibility: 1, informationQuality: 1, interactionCost: 0
};

class ObservedBrowserFixture implements CapabilityProvider {
  readonly name = 'c05.observed-browser-fixture';
  url = 'https://fixture.example/start';
  calls: string[] = [];
  supports(action: ActionRequest): boolean {
    return action.capability === 'browser.inspect' || action.capability === 'browser.navigate';
  }
  score(): CapabilityScore { return SCORE; }
  async execute(action: ActionRequest): Promise<ActionResult> {
    this.calls.push(action.capability);
    if (action.capability === 'browser.navigate') {
      assert.equal(action.input.targetId, 'fixture-tab');
      this.url = String(action.input.url);
      return { ok: true, capability: action.capability, provider: this.name,
        output: { targetId: 'fixture-tab', url: this.url, title: 'Verified destination' },
        evidence: [], durationMs: 1 };
    }
    const output = action.input.targetId
      ? { target: { id: 'fixture-tab', type: 'page', title: 'Verified destination', url: this.url },
          page: { semantic: { headings: ['Verified destination'] } } }
      : { tabs: [{ id: 'fixture-tab', type: 'page', title: 'Start', url: this.url }] };
    return { ok: true, capability: action.capability, provider: this.name,
      output, evidence: [], durationMs: 1 };
  }
}

test('C05 reviewed AI proposal is persisted first, then separately authorized and independently verified', async t => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-c05-reviewed-chain-'));
  t.after(async () => { await fs.rm(state, { recursive: true, force: true }); });
  const fixture = new ObservedBrowserFixture();
  const runtime = new OperatorRuntime().register(fixture);
  const store = new TaskStore(state);
  const orchestrator = new TaskOrchestrator({
    runtime, store,
    permissions: {
      allowedCapabilities: ['browser.inspect', 'browser.navigate'], allowedRoots: [],
      allowDestructive: false, allowExternalWrites: false, allowSystemChanges: false
    }
  });
  const scope = {
    objective: 'Navigate to the consented documentation page',
    approvedBrowserOrigins: ['https://fixture.example'],
    approvedRoots: []
  };
  const proposed = {
    goal: { kind: 'browser-navigation', url: 'https://fixture.example/destination' },
    successConditions: ['Reinspect the destination using the authoritative browser provider']
  };
  let modelCalls = 0, reservations = 0, submissions = 0, nativeReviews = 0;
  const model = new BoundedModelGoalInference({
    modelId: 'fixture-model', maxOutputTokens: 256, maxCostMicros: 0,
    timeoutMs: 1500,
    ledger: {
      async reserve() { reservations++; return { reservationId: 'fixture-reservation' }; },
      async finalize() {}
    },
    generator: { async generate() { modelCalls++; return { text: JSON.stringify(proposed) }; } }
  });
  const intake = new TrustedReviewedModelTaskIntake({
    model, authority: {
      async currentApprovedScope(principal) {
        return principal === 'test-authenticated-owner' ? scope : null;
      },
      async verifyTrustedReview(request) {
        nativeReviews++;
        return request.principal === 'test-authenticated-owner'
          && request.reviewProof === 'test-independent-native-approval';
      },
      async submitReviewedTask(options) {
        submissions++;
        const task = await orchestrator.submit(options);
        return { id: task.id, executionStarted: false as const };
      }
    }
  });

  const draft = await intake.propose({
    principal: 'test-authenticated-owner', request: scope, allowModelTransmission: true
  });
  assert.equal(draft.executionStarted, false);
  assert.equal(reservations, 1);
  assert.equal(modelCalls, 1);
  assert.equal(submissions, 0);
  assert.deepEqual(await store.list(), []);
  await assert.rejects(intake.confirm({
    principal: 'test-authenticated-owner',
    proposalId: draft.proposalId,
    proposalDigest: draft.proposalDigest,
    reviewProof: true
  }), (error: any) => error?.code === 'TASK_MODEL_REVIEW_DENIED');
  assert.equal(submissions, 0);
  const queued = await intake.confirm({
    principal: 'test-authenticated-owner',
    proposalId: draft.proposalId,
    proposalDigest: draft.proposalDigest,
    reviewProof: 'test-independent-native-approval'
  });
  assert.equal(queued.executionStarted, false);
  assert.equal(submissions, 1);
  assert.ok(nativeReviews >= 2);
  assert.equal((await store.get(queued.taskId)).state, 'PENDING');
  assert.deepEqual(fixture.calls, [], 'task creation must not perform an action');

  const result = await orchestrator.run(queued.taskId);
  assert.equal(result.state, 'VERIFIED');
  assert.deepEqual(fixture.calls, ['browser.inspect', 'browser.navigate', 'browser.inspect']);
  assert.ok(result.execution?.records.every(record => record.observation?.schemaVersion === 2));
  assert.ok(result.evidence.some(item => item.kind === 'independent_task_verification' && item.status === 'pass'));
  await assert.rejects(intake.confirm({
    principal: 'test-authenticated-owner',
    proposalId: draft.proposalId,
    proposalDigest: draft.proposalDigest,
    reviewProof: 'test-independent-native-approval'
  }), (error: any) => error?.code === 'TASK_PROPOSAL_REVIEW_INVALID');
  assert.equal(submissions, 1);
  assert.equal((await store.get(queued.taskId)).state, 'VERIFIED');
  await runtime.close();
});
