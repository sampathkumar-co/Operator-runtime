import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildWave0TraceBundle, recordWave0Bundle, sha256 } from '../scripts/wave0-step-evidence.mjs';

const sourceCommit = 'a'.repeat(40);
const digest = (c = 'b') => c.repeat(64);
const base = (changes = {}) => ({
  runId: 'run_001', lane: 'B', arm: 'mecord_scripted', scenarioId: 'isolated_repo_task',
  seed: 0, step: 0, attempt: 0, phase: 'observe', actionId: 'read_001',
  capability: 'git.status', risk: 'read', sideEffectState: 'none',
  observationDigest: digest(), actionDigest: digest('c'), resultDigest: digest('d'),
  timestampMs: 100, ...changes
});
function bundle(steps, overrides = {}) {
  return buildWave0TraceBundle({
    sourceCommit, controllerId: 'controller_fixture', recorderId: 'trace_writer',
    steps, ...overrides
  });
}
test('C01 transcript preserves deterministic bounded hashed JSONL without inventing a scored result', () => {
  const rows = [base(), base({ phase: 'decision', timestampMs: 101 }),
    base({ phase: 'result', timestampMs: 102 })];
  const first = bundle(rows);
  const second = bundle(rows);
  assert.deepEqual(first.manifest, second.manifest);
  assert.equal(first.manifest.eventCount, 3);
  assert.equal(first.manifest.scorecardCount, 0);
  assert.equal(first.manifest.unmatchedExecutionCount, 1);
  assert.equal(first.manifest.releaseAcceptance, 'NOT_ACCEPTED');
  assert.equal(first.manifest.physicalAcceptance, 'NOT_VERIFIED');
  assert.equal(sha256(first.traceJsonl), first.manifest.traceSha256);
  assert.equal(first.traceJsonl.trim().split('\n').length, 3);
});

test('C01 model-only lane cannot conceal provider dispatch or external action effects', () => {
  const a = base({ lane: 'A', arm: 'model_only', capability: 'model.answer' });
  assert.throws(() => bundle([{ ...a, phase: 'dispatch' }]), /Lane A must not dispatch/);
  assert.throws(() => bundle([{ ...a, sideEffectState: 'uncertain' }]), /must never claim external/);
});
test('C01 mutation retry is blocked after uncertain effect even if later event changes reported side effect to none', () => {
  const original = base({ actionId: 'unsafe_action', risk: 'external', capability: 'browser.interact',
    phase: 'dispatch', sideEffectState: 'uncertain' });
  const downgrade = { ...original, phase: 'result', timestampMs: 101, sideEffectState: 'none' };
  const replay = { ...original, phase: 'dispatch', timestampMs: 102, attempt: 1,
    sideEffectState: 'none' };
  assert.throws(() => bundle([original, downgrade, replay]), /mutating action retried/);
});
test('C01 read retries remain possible, and duplicate step identities or missing sequence fail closed', () => {
  const step0 = base();
  const retry = base({ attempt: 1, phase: 'observe', timestampMs: 101 });
  assert.equal(bundle([step0, retry]).manifest.eventCount, 2);
  assert.throws(() => bundle([step0, step0]), /duplicate step event/);
  assert.throws(() => bundle([step0, base({ step: 3, timestampMs: 105 })]), /missing step number/);
});
test('C01 raw observations and credentials cannot enter the digest-only record schema', () => {
  assert.throws(() => bundle([base({ rawObservation: 'API_TOKEN_EXAMPLE' })]), /disallowed raw field/);
  assert.throws(() => bundle([base({ actionDigest: 'raw-action-text' })]), /must be a content digest/);
  assert.throws(() => bundle([base({ timestampMs: 1.5 })]), /nonnegative integer/);
});
test('C01 recorded scorer claim is never confused with independently authenticated real-world success', () => {
  const scorePayload = {
    runId: 'run_001', arm: 'mecord_scripted', scenarioId: 'isolated_repo_task',
    scorerId: 'independent_fixture_oracle', verdict: 'pass',
    oracleDigest: digest('e'), outcomeEvidenceDigest: digest('f')
  };
  const scoring = { ...scorePayload, scorecardDigest: sha256(JSON.stringify(scorePayload)) };
  const retag = (updates: Record<string, string>) => {
    const next = { ...scorePayload, ...updates };
    return { ...next, scorecardDigest: sha256(JSON.stringify(next)) };
  };
  const ok = bundle([base()], { scorecards: [scoring] });
  assert.equal(ok.manifest.scorecardCount, 1);
  assert.equal(ok.manifest.scorerStatus, 'EXTERNAL_SCORECARDS_RECORDED_NOT_INDEPENDENTLY_AUTHENTICATED');
  assert.equal(ok.manifest.releaseAcceptance, 'NOT_ACCEPTED');
  assert.throws(() => bundle([base()], { scorecards: [retag({ scorerId: 'controller_fixture' })] }),
    /not separate/);
  assert.throws(() => bundle([base()], { scorecards: [retag({ scenarioId: 'other' })] }),
    /no matching trace/);
  assert.throws(() => bundle([base()], { scorecards: [scoring, scoring] }), /duplicate scorer/);
  assert.throws(() => bundle([base()], { scorecards: [{ ...scoring, verdict: 'fail' }] }), /scorecard hash/);
});
test('C01 recorder never overwrites an existing evidence directory', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wave0-record-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const inputPath = path.join(root, 'input.json');
  await fs.writeFile(inputPath, JSON.stringify({
    controllerId: 'controller_fixture', recorderId: 'trace_writer', steps: [base()]
  }));
  const outputDirectory = path.join(root, 'out');
  const first = await recordWave0Bundle({ inputPath, outputDirectory, sourceCommit });
  assert.equal((await fs.readFile(path.join(first.directory, 'steps.jsonl'), 'utf8')).trim().length > 0, true);
  await assert.rejects(recordWave0Bundle({ inputPath, outputDirectory, sourceCommit }), /EEXIST/);
});

test('C01 evidence recorder refuses oversized inputs before creating any output directory', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wave0-evidence-bound-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const oversized = path.join(root, 'oversized.json');
  const handle = await fs.open(oversized, 'w');
  try { await handle.truncate(32 * 1024 * 1024 + 1); } finally { await handle.close(); }
  const outputDirectory = path.join(root, 'out');
  await assert.rejects(recordWave0Bundle({
    inputPath: oversized, outputDirectory, sourceCommit
  }), /input evidence size invalid/);
  await assert.rejects(fs.stat(outputDirectory), (error: any) => error?.code === 'ENOENT');
});
test('C01 evidence recorder rejects non-object campaign roots rather than spreading array fields', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wave0-evidence-shape-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const inputPath = path.join(root, 'array.json');
  await fs.writeFile(inputPath, '[]');
  await assert.rejects(recordWave0Bundle({
    inputPath, outputDirectory: path.join(root, 'out'), sourceCommit
  }), /input evidence must be a JSON object/);
});
