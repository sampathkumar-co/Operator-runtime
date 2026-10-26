import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { RelayResultStore } from '../src/core/relay-result-store.ts';

export const CONCURRENCY_LEVELS = Object.freeze([1, 10, 100, 1000]);
export const PROFILE = 'SYNTHETIC_RESULT_WAIT_ONLY';
const WINDOW_MS = 160;

export async function runRelayResultWaitScaling({
  levels = CONCURRENCY_LEVELS,
  waitWindowMs = WINDOW_MS
} = {}) {
  if (!Array.isArray(levels) || levels.length === 0 || levels.length > 10 ||
    levels.some(value => !Number.isSafeInteger(value) || value < 1 || value > 1000) ||
    typeof waitWindowMs !== 'number' || !Number.isFinite(waitWindowMs) ||
    waitWindowMs < 50 || waitWindowMs > 5000) {
    throw new Error('Synthetic relay load profile is outside bounded limits.');
  }
  const rows = [];
  for (const concurrency of levels) {
    let durableReads = 0;
    // No live relay, user receipt or original device; a read-only in-memory
    // substitute measures polling fanout rather than production completion.
    const sharedStore = { async list() { durableReads++; return []; } };
    const store = new RelayResultStore(process.cwd(), { sharedStore });
    const deviceId = crypto.randomUUID();
    const controller = new AbortController();
    const started = performance.now();
    const waits = Array.from({ length: concurrency }, (_, i) =>
      store.waitFor(deviceId, i + 1, crypto.randomUUID(), waitWindowMs + 1000, controller.signal));
    await new Promise(resolve => setTimeout(resolve, waitWindowMs));
    controller.abort();
    const results = await Promise.all(waits);
    if (results.some(result => result !== null)) {
      throw new Error('Synthetic cancellation unexpectedly returned a stored result.');
    }
    rows.push({
      concurrentWaits: concurrency,
      durableReads,
      elapsedMs: Math.round(performance.now() - started),
      allCancelled: true
    });
  }
  return {
    schemaVersion: 1,
    profile: PROFILE,
    acceptedAsProductionBenchmark: false,
    verifiedSuccessfulActions: 0,
    limitations: 'No provider work, durable result write, host outage, latency p95, or end-to-end action verification.',
    samples: rows
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.stdout.write(JSON.stringify(await runRelayResultWaitScaling(), null, 2) + '\n');
  } catch (error) {
    process.stderr.write('Synthetic relay wait profile failed: ' +
      (error instanceof Error ? error.message : String(error)) + '\n');
    process.exitCode = 1;
  }
}
