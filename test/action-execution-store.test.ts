import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalActionExecutionStore } from '../apps/local-agent/src/action-execution-store.ts';
import { ActionTransitionJournal, type ActionCompletionFaultPoint } from '../src/core/action-transition-journal.ts';
import { kernelVerificationEvidence, verifyActionOutcome } from '../src/core/action-verification.ts';

async function temp(t: test.TestContext): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-action-execution-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function action(id = 'action-1') {
  return {
    id,
    capability: 'file.create',
    risk: 'write' as const,
    input: { path: 'C:\\repo\\receipt.txt', content: 'hello' },
    provenance: { kind: 'chatgpt' as const }
  };
}

const authority = {
  accountId: '11111111-1111-4111-8111-111111111111',
  deviceId: '22222222-2222-4222-8222-222222222222',
  generation: 3
};

const result = {
  ok: true,
  capability: 'file.create',
  provider: 'filesystem.native',
  output: { path: 'C:\\repo\\receipt.txt', created: true },
  evidence: [],
  durationMs: 12
};

function verifiedResult(verificationDigest: string) {
  return {
    ...result,
    evidence: [{
      kind: 'kernel_verification',
      status: 'pass' as const,
      message: 'Kernel verified the action outcome.',
      data: { verificationDigest },
      timestamp: new Date().toISOString()
    }]
  };
}

async function completeKernel(journal: ActionTransitionJournal, request = action(), output = result) {
  const verificationDigest = 'a'.repeat(64);
  const completedOutput = {
    ...output,
    evidence: [...output.evidence, {
      kind: 'kernel_verification',
      status: 'pass' as const,
      message: 'Kernel verified the action outcome.',
      data: { verificationDigest },
      timestamp: new Date().toISOString()
    }]
  };
  await journal.prepare({ action: request, ownerKind: 'local-api', ownerId: request.id, resourceKeys: ['path:c:\\repo\\receipt.txt'] });
  await journal.markDispatched(request.id, output.provider);
  await journal.observe(request.id, output);
  await journal.complete(request.id, verificationDigest, completedOutput);
  return completedOutput;
}

test('durable action execution receipt completes once and replays exact result after restart', async (t) => {
  const state = await temp(t);
  const store = new LocalActionExecutionStore(state);
  assert.equal((await store.begin(action(), authority)).status, 'started');
  const completed = await store.complete(action(), result, authority);
  assert.equal(completed.status, 'completed');

  const restarted = new LocalActionExecutionStore(state);
  const replay = await restarted.begin(action(), authority);
  assert.equal(replay.status, 'completed');
  assert.deepEqual(replay.status === 'completed' ? replay.result : null, result);
  assert.deepEqual((await restarted.lookup(action(), authority)).status, 'completed');
});

test('processing action execution receipt survives restart and prevents blind duplicate execution', async (t) => {
  const state = await temp(t);
  const store = new LocalActionExecutionStore(state);
  assert.equal((await store.begin(action('processing'), authority)).status, 'started');

  const restarted = new LocalActionExecutionStore(state);
  const duplicate = await restarted.begin(action('processing'), authority);
  assert.equal(duplicate.status, 'processing');
  assert.equal((await restarted.lookup(action('processing'), authority)).status, 'processing');
});

test('orphaned processing read is reclaimable after process restart while mutations remain blocked', async (t) => {
  const state = await temp(t);
  const readAction = {
    id: 'read-restart',
    capability: 'file.read',
    risk: 'read' as const,
    input: { path: 'C:\\repo\\receipt.txt' },
    provenance: { kind: 'chatgpt' as const }
  };
  const first = new LocalActionExecutionStore(state);
  assert.equal((await first.begin(readAction, authority)).status, 'started');

  const restarted = new LocalActionExecutionStore(state);
  assert.equal((await restarted.begin(readAction, authority)).status, 'started', 'read-only work may be reclaimed by a new process incarnation');

  const writeAction = action('write-restart');
  assert.equal((await first.begin(writeAction, authority)).status, 'started');
  const restartedAgain = new LocalActionExecutionStore(state);
  assert.equal((await restartedAgain.begin(writeAction, authority)).status, 'processing', 'mutation receipt must remain fail-closed across restart');
});

test('completed read receipt is never replayed as stale state', async (t) => {
  const state = await temp(t);
  const readAction = {
    id: 'read-fresh',
    capability: 'file.read',
    risk: 'read' as const,
    input: { path: 'C:\\repo\\fresh.txt' },
    provenance: { kind: 'chatgpt' as const }
  };
  const store = new LocalActionExecutionStore(state);
  assert.equal((await store.begin(readAction, authority)).status, 'started');
  await store.complete(readAction, {
    ok: true,
    capability: 'file.read',
    provider: 'filesystem.native',
    output: { content: 'old' },
    evidence: [],
    durationMs: 1
  }, authority);
  assert.equal((await store.begin(readAction, authority)).status, 'started', 'completed read must be executed again to observe current state');
});

test('action ID cannot be rebound to changed executable content', async (t) => {
  const state = await temp(t);
  const store = new LocalActionExecutionStore(state);
  await store.begin(action('content-bound'), authority);
  const changed = { ...action('content-bound'), input: { path: 'C:\\repo\\other.txt', content: 'changed' } };
  await assert.rejects(store.begin(changed, authority), (error: any) => error?.code === 'ACTION_EXECUTION_ACTION_MISMATCH');
});

test('action ID cannot be rebound to different account authority', async (t) => {
  const state = await temp(t);
  const store = new LocalActionExecutionStore(state);
  await store.begin(action('authority-bound'), authority);
  await assert.rejects(store.begin(action('authority-bound'), { ...authority, generation: 4 }), (error: any) => error?.code === 'ACTION_EXECUTION_AUTHORITY_MISMATCH');
});

test('completed receipt rejects a conflicting second result', async (t) => {
  const state = await temp(t);
  const store = new LocalActionExecutionStore(state);
  await store.begin(action('result-bound'), authority);
  await store.complete(action('result-bound'), result, authority);
  await assert.rejects(
    store.complete(action('result-bound'), { ...result, output: { path: 'different' } }, authority),
    (error: any) => error?.code === 'ACTION_EXECUTION_RESULT_CONFLICT'
  );
});

test('processing mutation converges to exact authoritative kernel completion without provider replay', async (t) => {
  const state = await temp(t);
  const request = action('kernel-repair');
  const store = new LocalActionExecutionStore(state);
  await store.begin(request, authority);
  const journal = new ActionTransitionJournal(state);
  const authoritativeResult = await completeKernel(journal, request, result);

  const repaired = await new LocalActionExecutionStore(state).reconcileWithKernel(request, authority, journal);
  assert.equal(repaired.status, 'completed');
  assert.deepEqual(repaired.status === 'completed' ? repaired.result : null, authoritativeResult);
  assert.equal(repaired.status === 'completed' ? repaired.record.kernelCompletion?.journalGeneration : 0, 1);
  assert.equal(repaired.status === 'completed' ? repaired.record.kernelCompletion?.verificationDigest : '', 'a'.repeat(64));
  assert.match(repaired.status === 'completed' ? repaired.record.kernelCompletion?.resultDigest ?? '' : '', /^[0-9a-f]{64}$/);

  const repeated = await new LocalActionExecutionStore(state).reconcileWithKernel(request, authority, journal);
  assert.equal(repeated.status, 'completed');
  assert.deepEqual(repeated.status === 'completed' ? repeated.result : null, authoritativeResult);
});

test('processing receipt remains unresolved when kernel mutation is uncertain', async (t) => {
  const state = await temp(t);
  const request = action('kernel-uncertain');
  const store = new LocalActionExecutionStore(state);
  await store.begin(request, authority);
  const journal = new ActionTransitionJournal(state);
  await journal.prepare({ action: request, ownerKind: 'local-api', ownerId: request.id, resourceKeys: [] });
  await journal.markDispatched(request.id, 'filesystem.native');
  await journal.observe(request.id, {
    ok: false, capability: request.capability, provider: 'filesystem.native', evidence: [], durationMs: 1,
    error: { code: 'WRITE_UNCERTAIN', message: 'effect unknown', sideEffectState: 'uncertain' }
  });

  const unresolved = await new LocalActionExecutionStore(state).reconcileWithKernel(request, authority, journal);
  assert.equal(unresolved.status, 'processing');
});

test('successful receipt without matching kernel completion fails closed', async (t) => {
  const state = await temp(t);
  const request = action('receipt-ahead-of-kernel');
  const store = new LocalActionExecutionStore(state);
  await store.begin(request, authority);
  await store.complete(request, result, authority);
  const journal = new ActionTransitionJournal(state);
  await assert.rejects(
    store.reconcileWithKernel(request, authority, journal),
    (error: any) => error?.code === 'ACTION_EXECUTION_RECONCILIATION_REQUIRED'
  );
});

test('kernel reconciliation rejects mismatched execution digest and stale authority generation', async (t) => {
  const state = await temp(t);
  const request = action('kernel-lineage-mismatch');
  const store = new LocalActionExecutionStore(state);
  await store.begin(request, authority);
  const journal = new ActionTransitionJournal(state);
  const changed = { ...request, input: { ...request.input, content: 'different-attempt' } };
  await completeKernel(journal, changed, result);

  await assert.rejects(
    store.reconcileWithKernel(request, authority, journal),
    (error: any) => error?.code === 'ACTION_EXECUTION_RECONCILIATION_REQUIRED'
  );
  await assert.rejects(
    store.reconcileWithKernel(request, { ...authority, generation: authority.generation + 1 }, journal),
    (error: any) => error?.code === 'ACTION_EXECUTION_AUTHORITY_MISMATCH'
  );
});

test('stale stored kernel proof cannot be accepted as a newer completion attempt', async (t) => {
  const state = await temp(t);
  const request = action('stale-kernel-proof');
  const store = new LocalActionExecutionStore(state);
  await store.begin(request, authority);
  const journal = new ActionTransitionJournal(state);
  await completeKernel(journal, request, result);
  await store.reconcileWithKernel(request, authority, journal);

  const file = path.join(state, 'action-executions.json');
  const raw = JSON.parse(await fs.readFile(file, 'utf8'));
  raw.records[0].kernelCompletion.journalGeneration = 2;
  await fs.writeFile(file, JSON.stringify(raw));
  await assert.rejects(
    new LocalActionExecutionStore(state).reconcileWithKernel(request, authority, journal),
    (error: any) => error?.code === 'ACTION_EXECUTION_RECONCILIATION_REQUIRED'
  );
});

test('staged mutation completion converges after a crash at every durable publication boundary', async (t) => {
  for (const point of [
    'after_result_staged',
    'after_journal_completed',
    'after_result_published'
  ] as const satisfies readonly ActionCompletionFaultPoint[]) {
    await t.test(point, async (t) => {
      const state = await temp(t);
      const request = action(`completion-${point}`);
      const verificationDigest = crypto.createHash('sha256').update(point).digest('hex');
      const output = verifiedResult(verificationDigest);
      const store = new LocalActionExecutionStore(state);
      await store.begin(request, authority);
      let injected = false;
      const journal = new ActionTransitionJournal(state, {
        completionFault: (candidate) => {
          if (!injected && candidate === point) {
            injected = true;
            throw new Error(`crash:${point}`);
          }
        }
      });
      await journal.prepare({ action: request, ownerKind: 'local-api', ownerId: request.id, resourceKeys: ['path:c:\\repo\\receipt.txt'] });
      await journal.markDispatched(request.id, output.provider);
      await journal.observe(request.id, output);
      await assert.rejects(journal.complete(request.id, verificationDigest, output), new RegExp(`crash:${point}`));
      assert.equal(injected, true);

      const restartedJournal = new ActionTransitionJournal(state);
      const repaired = await new LocalActionExecutionStore(state).reconcileWithKernel(request, authority, restartedJournal);
      assert.equal(repaired.status, 'completed');
      assert.deepEqual(repaired.status === 'completed' ? repaired.result : null, output);
      const entry = await restartedJournal.inspect(request.id);
      assert.equal(entry.state, 'COMPLETED');
      const completion = entry.transitions.at(-1)!;
      assert.equal(completion.verificationDigest, verificationDigest);
      assert.match(completion.resultDigest ?? '', /^[0-9a-f]{64}$/);
      assert.deepEqual(await restartedJournal.replayCompleted(request.id), output);

      const repeated = await new LocalActionExecutionStore(state).reconcileWithKernel(request, authority, restartedJournal);
      assert.equal(repeated.status, 'completed');
      assert.equal((await restartedJournal.inspect(request.id)).transitions.filter((item) => item.state === 'COMPLETED').length, 1);
    });
  }
});

test('staged completion tamper cannot manufacture a completed journal transition', async (t) => {
  const state = await temp(t);
  const request = action('completion-stage-tamper');
  const verificationDigest = 'c'.repeat(64);
  const output = verifiedResult(verificationDigest);
  const journal = new ActionTransitionJournal(state, {
    completionFault: (point) => {
      if (point === 'after_result_staged') throw new Error('crash after stage');
    }
  });
  await journal.prepare({ action: request, ownerKind: 'local-api', ownerId: request.id, resourceKeys: [] });
  await journal.markDispatched(request.id, output.provider);
  await journal.observe(request.id, output);
  await assert.rejects(journal.complete(request.id, verificationDigest, output), /crash after stage/);

  const key = crypto.createHash('sha256').update(request.id).digest('hex');
  const stagedFile = path.join(state, 'action-results', `${key}.staged.json`);
  const staged = JSON.parse(await fs.readFile(stagedFile, 'utf8'));
  staged.journalGeneration += 1;
  await fs.writeFile(stagedFile, JSON.stringify(staged));
  const restarted = new ActionTransitionJournal(state);
  await assert.rejects(
    restarted.recoverPendingCompletion(request.id),
    (error: any) => error?.code === 'ACTION_JOURNAL_COMPLETION_CONFLICT'
  );
  assert.equal((await restarted.inspect(request.id)).state, 'OBSERVED');
});

test('hard-linked staged completion authority is rejected without advancing the journal', async (t) => {
  const state = await temp(t);
  const request = action('completion-stage-hardlink');
  const verificationDigest = 'f'.repeat(64);
  const output = verifiedResult(verificationDigest);
  const journal = new ActionTransitionJournal(state, {
    completionFault: (point) => {
      if (point === 'after_result_staged') throw new Error('crash after stage');
    }
  });
  await journal.prepare({ action: request, ownerKind: 'local-api', ownerId: request.id, resourceKeys: [] });
  await journal.markDispatched(request.id, output.provider);
  await journal.observe(request.id, output);
  await assert.rejects(journal.complete(request.id, verificationDigest, output), /crash after stage/);

  const key = crypto.createHash('sha256').update(request.id).digest('hex');
  const stagedFile = path.join(state, 'action-results', `${key}.staged.json`);
  const outside = path.join(state, 'outside-staged-result.json');
  await fs.rename(stagedFile, outside);
  await fs.link(outside, stagedFile);

  const restarted = new ActionTransitionJournal(state);
  await assert.rejects(
    restarted.recoverPendingCompletion(request.id, request),
    (error: any) => error?.code === 'ACTION_JOURNAL_RESULT_CORRUPT'
  );
  assert.equal((await restarted.inspect(request.id)).state, 'OBSERVED');
});

test('conflicting retries cannot replace immutable staged or published completion evidence', async (t) => {
  const state = await temp(t);
  const request = action('completion-conflict');
  const verificationDigest = 'e'.repeat(64);
  const output = verifiedResult(verificationDigest);
  const journal = new ActionTransitionJournal(state, {
    completionFault: (point) => {
      if (point === 'after_result_staged') throw new Error('crash after stage');
    }
  });
  await journal.prepare({ action: request, ownerKind: 'local-api', ownerId: request.id, resourceKeys: [] });
  await journal.markDispatched(request.id, output.provider);
  await journal.observe(request.id, output);
  await assert.rejects(journal.complete(request.id, verificationDigest, output), /crash after stage/);

  const conflicting = { ...output, output: { path: 'different-result' } };
  await assert.rejects(
    new ActionTransitionJournal(state).complete(request.id, verificationDigest, conflicting),
    (error: any) => error?.code === 'ACTION_JOURNAL_COMPLETION_CONFLICT'
  );
  const restarted = new ActionTransitionJournal(state);
  await restarted.recoverPendingCompletion(request.id, request);
  assert.deepEqual(await restarted.replayCompleted(request.id), output);

  const key = crypto.createHash('sha256').update(request.id).digest('hex');
  const finalFile = path.join(state, 'action-results', `${key}.json`);
  await fs.writeFile(finalFile, JSON.stringify(conflicting));
  await assert.rejects(
    restarted.complete(request.id, verificationDigest, output),
    (error: any) => error?.code === 'ACTION_JOURNAL_COMPLETION_CONFLICT'
  );
});

test('legacy result-first crash window is upgraded only with embedded kernel verification lineage', async (t) => {
  const state = await temp(t);
  const request = action('legacy-result-first');
  const providerResult = {
    ...result,
    evidence: [{
      kind: 'postcondition',
      status: 'pass' as const,
      message: 'The requested state was observed.',
      timestamp: new Date().toISOString()
    }]
  };
  const journal = new ActionTransitionJournal(state);
  await journal.prepare({ action: request, ownerKind: 'local-api', ownerId: request.id, resourceKeys: [] });
  await journal.markDispatched(request.id, providerResult.provider);
  const observed = await journal.observe(request.id, providerResult);
  const receipt = verifyActionOutcome({ action: request, result: providerResult, journal: observed });
  assert.equal(receipt.verified, true);
  const verificationDigest = receipt.digest;
  const output = { ...providerResult, evidence: [...providerResult.evidence, kernelVerificationEvidence(receipt)] };
  const key = crypto.createHash('sha256').update(request.id).digest('hex');
  const resultDir = path.join(state, 'action-results');
  await fs.mkdir(resultDir, { recursive: true });
  await fs.writeFile(path.join(resultDir, `${key}.json`), JSON.stringify(output));

  const recovered = await new ActionTransitionJournal(state).recoverPendingCompletion(request.id, request);
  assert.equal(recovered.state, 'COMPLETED');
  assert.equal(recovered.transitions.at(-1)?.verificationDigest, verificationDigest);
  assert.deepEqual(await new ActionTransitionJournal(state).replayCompleted(request.id), output);
});
