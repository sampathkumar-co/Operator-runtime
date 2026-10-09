import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ShadowDecisionStore } from '../src/core/shadow-decision-store.ts';

test('independent shadow decision stores preserve every concurrent append across instances and restart', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-shadow-decision-race-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const stores = Array.from({ length: 8 }, () => new ShadowDecisionStore(dir));
  const inputs = Array.from({ length: 20 }, (_, index) => ({
    source: 'ADAPTIVE_INTELLIGENCE' as const,
    executionContextDigest: 'a'.repeat(64),
    stateDigest: crypto.createHash('sha256').update(String(index)).digest('hex'),
    recommendation: 'WAIT' as const,
    reasonCode: 'CONCURRENT_SHADOW_DECISION',
    at: '2026-10-09T04:00:00.000Z'
  }));
  const appended = await Promise.all(inputs.map((input, index) =>
    stores[index % stores.length]!.append(input)
  ));
  const restarted = new ShadowDecisionStore(dir);
  const persisted = await restarted.list({ limit: 50 });
  assert.equal(persisted.length, 20);
  assert.equal(new Set(persisted.map(row => row.id)).size, 20);
  assert.deepEqual(new Set(persisted.map(row => row.id)), new Set(appended.map(row => row.id)));
  const disk = await fs.readFile(path.join(dir, 'shadow-decisions.ndjson'), 'utf8');
  assert.equal(disk.trimEnd().split('\n').length, 20);
});
