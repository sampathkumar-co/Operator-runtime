// Synthetic local durability + waiter fanout diagnostic. No real relay, MCP,
// user account, externally executed operation, or production performance claim.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { RelayResultStore } from '../src/core/relay-result-store.ts';

export const LEVELS = Object.freeze([1, 10, 100, 1000]);
const quantile = (sorted, p) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
export async function runDurableWaitFanout({ levels = LEVELS } = {}) {
  if (!Array.isArray(levels) || levels.length === 0 || levels.length > LEVELS.length ||
      levels.some(n => !LEVELS.includes(n)) || new Set(levels).size !== levels.length) {
    throw new Error('C09_FANOUT_LEVEL_INVALID');
  }
  const rows = [];
  for (const count of levels) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-c09-durable-fanout-'));
    let watchdog;
    try {
      const reader = new RelayResultStore(root);
      // Separate instance exercises durable fallback, not direct in-process notify.
      const writer = new RelayResultStore(root);
      const deviceId = crypto.randomUUID();
      const deliveryId = crypto.randomUUID();
      const now = performance.now();
      const waits = Array.from({ length: count }, () => reader.waitFor(deviceId, 1, deliveryId, 10_000)
        .then(result => ({ result, ms: performance.now() - now })));
      const timeout = new Promise((_, reject) => {
        watchdog = setTimeout(() => reject(new Error('C09_FANOUT_TIMEOUT')), 15_000);
      });
      const saved = await writer.put(deviceId, 1, deliveryId, { ok: true, output: { type: 'synthetic' } });
      const results = await Promise.race([Promise.all(waits), timeout]);
      assert.equal(saved.duplicate, false);
      assert.ok(results.every(row => row.result?.deliveryId === deliveryId &&
        row.result?.resultSha256 === saved.result.resultSha256 &&
        row.result?.result?.ok === true), 'durable identity and payload proof required');
      assert.equal((await reader.get(deviceId, 1))?.deliveryId, deliveryId);
      const durations = results.map(result => result.ms).sort((a, b) => a - b);
      rows.push({
        concurrentWaiters: count,
        durableCommits: 1,
        independentlyObserved: results.length,
        p50Ms: Math.round(quantile(durations, .5) * 100) / 100,
        p95Ms: Math.round(quantile(durations, .95) * 100) / 100
      });
    } finally {
      if (watchdog) clearTimeout(watchdog);
      await fs.rm(root, { recursive: true, force: true });
    }
  }
  return {
    schemaVersion: 1,
    profile: 'LOCAL_SINGLE_DURABLE_RESULT_FANOUT',
    acceptedAsProductionBenchmark: false,
    sourceBaselineCompared: false,
    verifiedExternalActions: 0,
    limitations: 'One durable result per concurrency level; does not measure 1000 real actions, MCP, device relay or model overhead.',
    rows
  };
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.stdout.write(JSON.stringify(await runDurableWaitFanout(), null, 2) + '\n');
}
