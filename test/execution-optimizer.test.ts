import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ExecutionOptimizerStore } from '../src/core/execution-optimizer.ts';

async function tempDir(t: test.TestContext): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-optimizer-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('stage9 learns only among caller-authorized strategies and never invents authority', async (t) => {
  const store = new ExecutionOptimizerStore(await tempDir(t));
  for (let i = 0; i < 30; i += 1) {
    await store.record('deploy', 'safe-a', { verified: false, durationMs: 5000, retries: 2, costUnits: 10 });
    await store.record('deploy', 'safe-b', { verified: true, durationMs: 1000, retries: 0, costUnits: 5 });
  }
  await store.record('deploy', 'not-authorized', { verified: true, durationMs: 1, retries: 0, costUnits: 0 });
  const ranked = await store.recommend('deploy', [
    { id: 'safe-a', staticScore: 0.8 },
    { id: 'safe-b', staticScore: 0.78 }
  ]);
  assert.equal(ranked[0]?.id, 'safe-b');
  assert.deepEqual(new Set(ranked.map((item) => item.id)), new Set(['safe-a', 'safe-b']));
  assert.ok(ranked.every((item) => Math.abs(item.learnedAdjustment) <= 0.1));
});

test('stage9 concurrency tuning is bounded by caller policy ceiling and floor', async (t) => {
  const store = new ExecutionOptimizerStore(await tempDir(t));
  for (let i = 0; i < 20; i += 1) await store.record('org-rollout', 'wave', { verified: true, retries: 0, durationMs: 100 });
  assert.equal(await store.recommendConcurrency('org-rollout', 'wave', { current: 4, min: 1, policyMax: 4 }), 4);
  assert.equal(await store.recommendConcurrency('org-rollout', 'wave', { current: 2, min: 1, policyMax: 4 }), 3);

  for (let i = 0; i < 20; i += 1) await store.record('fragile', 'wave', { verified: false, retries: 4, durationMs: 10000 });
  assert.equal(await store.recommendConcurrency('fragile', 'wave', { current: 2, min: 2, policyMax: 10 }), 2);
  assert.equal(await store.recommendConcurrency('fragile', 'wave', { current: 5, min: 2, policyMax: 10 }), 4);
});

test('stage9 optimizer state stores only bounded aggregate execution metadata', async (t) => {
  const state = await tempDir(t);
  const store = new ExecutionOptimizerStore(state);
  await store.record('context', 'strategy', { verified: true, durationMs: 123, retries: 1, costUnits: 2 });
  const raw = await fs.readFile(path.join(state, 'execution-optimizer.json'), 'utf8');
  const decoded = JSON.parse(raw);
  assert.deepEqual(Object.keys(decoded.entries[0]).sort(), [
    'context', 'costEwma', 'durationEwmaMs', 'failed', 'retriesEwma', 'samples', 'strategy', 'updatedAt', 'verified'
  ]);
  assert.equal(raw.includes('allowedCapabilities'), false);
  assert.equal(raw.includes('approvedActionIds'), false);
  assert.equal(raw.includes('allowDestructive'), false);
});

test('stage9 learning requires repeated evidence before changing ranking materially', async (t) => {
  const store = new ExecutionOptimizerStore(await tempDir(t));
  await store.record('build', 'a', { verified: false, durationMs: 100 });
  const once = await store.recommend('build', [{ id: 'a', staticScore: 0.8 }, { id: 'b', staticScore: 0.79 }]);
  assert.equal(once[0]?.id, 'a');
  for (let i = 0; i < 20; i += 1) await store.record('build', 'b', { verified: true, durationMs: 50 });
  const learned = await store.recommend('build', [{ id: 'a', staticScore: 0.8 }, { id: 'b', staticScore: 0.79 }]);
  assert.equal(learned[0]?.id, 'b');
});


test('stage9 receipt idempotency prevents crash retries from double-counting one outcome', async (t) => {
  const store = new ExecutionOptimizerStore(await tempDir(t));
  const receipt = 'a'.repeat(64);
  await store.record('retry-safe', 'strategy', { verified: true, durationMs: 100 }, receipt);
  await store.record('retry-safe', 'strategy', { verified: true, durationMs: 100 }, receipt);
  const entry = (await store.inspect()).find((item) => item.context === 'retry-safe' && item.strategy === 'strategy');
  assert.ok(entry);
  assert.equal(entry!.verified, 1);
  assert.equal(entry!.samples, 1);
});

test('cross-process optimizer receipts preserve independent writes and idempotent retries', async (t) => {
  const stateDir = await tempDir(t);
  const workerSource = `
    import crypto from 'node:crypto';
    import { ExecutionOptimizerStore } from ${JSON.stringify(new URL('../src/core/execution-optimizer.ts', import.meta.url).href)};
    const [stateDir, writerId] = process.argv.slice(1);
    const store = new ExecutionOptimizerStore(stateDir);
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const receipt = crypto.createHash('sha256').update(writerId + ':' + attempt).digest('hex');
      await store.record('cross-process-writer', 'bounded-aggregate', {
        verified: true, durationMs: 100, retries: 0, costUnits: 1
      }, receipt);
    }
  `;

  async function runWriter(writerId: string): Promise<void> {
    const child = spawn(process.execPath,
      ['--experimental-strip-types', '--input-type=module', '--eval', workerSource, stateDir, writerId],
      { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (part) => { stderr = (stderr + String(part)).slice(-3000); });
    await new Promise<void>((resolve, reject) => {
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, 30_000);
      child.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once('close', (code, signal) => {
        clearTimeout(timeout);
        if (code === 0 && !timedOut) resolve();
        else reject(new Error(
          `Optimizer writer ${writerId} failed (${code}/${signal}, timeout=${timedOut}): ${stderr}`
        ));
      });
    });
  }

  const writers = Array.from({ length: 4 }, (_, i) => 'writer-' + i);
  // Four independent operating-system processes write the SAME durable file.
  await Promise.all(writers.map(runWriter));
  const fresh = new ExecutionOptimizerStore(stateDir);
  const records = (await fresh.inspect()).filter(
    (entry) => entry.context === 'cross-process-writer' && entry.strategy === 'bounded-aggregate'
  );
  assert.equal(records.length, 1, 'no shared-writer updates may be lost or duplicated');
  assert.equal(records[0]?.verified, 24);
  assert.equal(records[0]?.samples, 24);
  assert.equal(records[0]?.failed, 0);

  // A fresh process after restart cannot count identical recovery receipts twice.
  await Promise.all(writers.map(runWriter));
  const afterRetry = (await new ExecutionOptimizerStore(stateDir).inspect()).find(
    (entry) => entry.context === 'cross-process-writer' && entry.strategy === 'bounded-aggregate'
  );
  assert.equal(afterRetry?.samples, 24);
  assert.equal(afterRetry?.verified, 24);
});
