import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RelayHub } from '../src/relay-hub.ts';

test('relay account runtime cache evicts idle tenants at its configured bound', async (t) => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-relay-cache-'));
  t.after(() => fs.rm(state, { recursive: true, force: true }));
  const hub = new RelayHub({ stateDir: state, maxAccountRuntimeCaches: 2 });
  const accounts = [
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000003'
  ];
  for (const accountId of accounts) {
    await assert.rejects(hub.boundProjectDevice(accountId, 'project'), (error: unknown) =>
      (error as { code?: string }).code === 'ROUTE_PROJECT_UNBOUND');
  }
  assert.deepEqual(hub.accountRuntimeCacheStats(), { accounts: 2, limit: 2, active: 0 });
});
