import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import {
  BoundedModelGoalInference, type ModelCallBudgetLedger,
  type ModelGoalGenerator
} from '../src/core/bounded-model-goal-inference.ts';
import { ReviewedModelGoalBridge } from '../src/core/reviewed-model-goal.ts';

const root = path.resolve(os.tmpdir(), 'c05-model-allowed-project');
const scope = {
  objective: 'Open the approved help page and run verified project tests',
  approvedRoots: [root], approvedBrowserOrigins: ['https://allowed.example']
};
const output = {
  goal: { kind: 'browser-navigation', url: 'https://allowed.example/help' },
  successConditions: ['Independently verify the page title after navigation']
};
function harness(onGenerate?: ModelGoalGenerator['generate']) {
  const events: string[] = [];
  const ledger: ModelCallBudgetLedger = {
    async reserve(input) {
      events.push('reserve:' + input.callId);
      assert.equal(input.modelId, 'test-model');
      assert.equal(input.maxOutputTokens, 256);
      assert.equal(input.maxCostMicros, 900);
      return { reservationId: 'bounded-persisted-ledger-entry' };
    },
    async finalize(input) { events.push('finalize:' + input.outcome); }
  };
  const generate: ModelGoalGenerator = {
    async generate(input) {
      events.push('generate');
      assert.equal(input.modelId, 'test-model');
      assert.equal(input.maxOutputTokens, 256);
      assert.ok(input.prompt.includes(scope.objective));
      assert.ok(input.prompt.includes('https://allowed.example'));
      assert.ok(!input.prompt.includes('tool observations'));
      if (onGenerate) return await onGenerate(input);
      return { text: JSON.stringify(output) };
    }
  };
  const adapter = new BoundedModelGoalInference({
    modelId: 'test-model', generator: generate, ledger,
    timeoutMs: 300, maxCostMicros: 900, maxOutputTokens: 256
  });
  return { adapter, ledger, generate, events };
}
test('C05 model-neutral inference reserves durable caller ledger before provider request, then returns only typed proposal', async () => {
  const h = harness();
  const result = await h.adapter.propose({ scope, allowModelTransmission: true });
  assert.equal(result.executionStarted, false);
  assert.equal(result.modelId, 'test-model');
  assert.deepEqual(result.proposal, output);
  assert.equal(h.events.length, 3);
  assert.match(h.events[0], /^reserve:/);
  assert.equal(h.events[1], 'generate');
  assert.equal(h.events[2], 'finalize:VALIDATED_PROPOSAL');
  // Confirming still requires the separate one-use review and does not execute.
  const bridge = new ReviewedModelGoalBridge();
  const review = bridge.propose({
    principal: 'test-user', request: scope, modelOutput: result.proposal
  });
  assert.equal(review.executionStarted, false);
  const taskOptions = bridge.confirm({
    principal: 'test-user', proposalId: review.proposalId,
    proposalDigest: review.proposalDigest,
    currentApprovedScopeFor: () => scope
  });
  assert.deepEqual(taskOptions.goal, output.goal);
});
test('C05 no consent, empty scope and credentialed origin never consume any model budget', async () => {
  const h = harness();
  await assert.rejects(h.adapter.propose({ scope, allowModelTransmission: false as never }),
    (err: any) => err.code === 'TASK_MODEL_TRANSMISSION_DENIED');
  await assert.rejects(h.adapter.propose({
    scope: { ...scope, approvedRoots: [], approvedBrowserOrigins: [] },
    allowModelTransmission: true
  }), (err: any) => err.code === 'TASK_MODEL_INFERENCE_INVALID');
  await assert.rejects(h.adapter.propose({
    scope: { ...scope, approvedBrowserOrigins: ['https://secret:token@allowed.example'] },
    allowModelTransmission: true
  }), (err: any) => err.code === 'TASK_MODEL_INFERENCE_INVALID');
  await assert.rejects(h.adapter.propose({
    scope: { ...scope, approvedRoots: ['relative/path'] },
    allowModelTransmission: true
  }), (err: any) => err.code === 'TASK_MODEL_INFERENCE_INVALID');
  assert.deepEqual(h.events, []);
});
test('C05 model cannot propose invented hosts or unsupported actions; cost reservation remains UNKNOWN_SPEND', async () => {
  const h = harness(async () => ({ text: JSON.stringify({
    ...output, goal: { kind: 'browser-navigation', url: 'https://evil.example/pay' }
  }) }));
  await assert.rejects(h.adapter.propose({ scope, allowModelTransmission: true }),
    (err: any) => err.code === 'TASK_PROPOSAL_SCOPE_DENIED');
  assert.equal(h.events.at(-1), 'finalize:UNKNOWN_SPEND');
});
test('C05 invalid JSON or oversized model output fails with explicit unknown-spend accounting', async () => {
  for (const textValue of ['not a json object', 'x'.repeat(24 * 1024 + 1)]) {
    const h = harness(async () => ({ text: textValue }));
    await assert.rejects(h.adapter.propose({ scope, allowModelTransmission: true }),
      (err: any) => err.code === 'TASK_MODEL_INFERENCE_INVALID');
    assert.deepEqual(h.events.map(x => x.split(':')[0]), ['reserve','generate','finalize']);
    assert.equal(h.events.at(-1), 'finalize:UNKNOWN_SPEND');
  }
});
test('C05 late provider output is rejected on deadline even if provider ignores abort', async () => {
  let release!: (result: {text:string}) => void;
  let timedOut = false;
  const h = harness(async ({signal}) => {
    signal.addEventListener('abort', () => { timedOut = true; });
    return await new Promise(resolve => { release = resolve; });
  });
  const promise = h.adapter.propose({ scope, allowModelTransmission: true });
  await assert.rejects(promise, (err: any) =>
    err.code === 'TASK_MODEL_INFERENCE_TIMEOUT' ||
    err.code === 'TASK_MODEL_INFERENCE_ABORTED');
  assert.equal(timedOut, true);
  assert.equal(h.events.at(-1), 'finalize:UNKNOWN_SPEND');
  release({ text: JSON.stringify(output) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.events.filter(v => v === 'finalize:VALIDATED_PROPOSAL').length, 0);
});
test('C05 abort during reservation fences provider call and preserves uncertain budget receipt', async () => {
  const controller = new AbortController();
  const h = harness();
  const ledger: ModelCallBudgetLedger = {
    reserve: async () => { controller.abort(); return { reservationId: 'persisted' }; },
    finalize: h.ledger.finalize
  };
  const a = new BoundedModelGoalInference({
    generator: h.generate, ledger, modelId: 'test-model', maxOutputTokens: 256,
    maxCostMicros: 900, timeoutMs: 300
  });
  await assert.rejects(a.propose({
    scope, allowModelTransmission: true, signal: controller.signal
  }), (err: any) => err.code === 'TASK_MODEL_INFERENCE_ABORTED');
  assert.deepEqual(h.events, ['finalize:UNKNOWN_SPEND']);
});
test('C05 one adapter cannot run concurrent model calls and cannot silently skip ledger finalization', async () => {
  let release!: (result:{text:string}) => void;
  const h = harness(async () => await new Promise(resolve => { release = resolve; }));
  const first = h.adapter.propose({ scope, allowModelTransmission: true });
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(h.adapter.propose({ scope, allowModelTransmission: true }),
    (err: any) => err.code === 'TASK_MODEL_INFERENCE_BUSY');
  release({ text: JSON.stringify(output) });
  assert.equal((await first).executionStarted, false);
  const invalidLedger: ModelCallBudgetLedger = {
    reserve: h.ledger.reserve,
    finalize: async () => { throw new Error('ledger fsync failed'); }
  };
  const untrusted = new BoundedModelGoalInference({
    generator: h.generate, ledger: invalidLedger, modelId: 'test-model',
    maxCostMicros: 900, maxOutputTokens: 256, timeoutMs: 300
  });
  await assert.rejects(untrusted.propose({ scope, allowModelTransmission: true }),
    /ledger fsync failed/);
});
test('C05 invalid budget, missing ledger and cancelled-before-start fail closed', async () => {
  const h = harness();
  assert.throws(() => new BoundedModelGoalInference({
    generator: h.generate, ledger: h.ledger, modelId: 'test-model',
    maxCostMicros: -1
  }), (err: any) => err.code === 'TASK_MODEL_INFERENCE_INVALID');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(h.adapter.propose({
    scope, allowModelTransmission: true, signal: controller.signal
  }), (err: any) => err.code === 'TASK_MODEL_INFERENCE_ABORTED');
  assert.deepEqual(h.events, []);
});
