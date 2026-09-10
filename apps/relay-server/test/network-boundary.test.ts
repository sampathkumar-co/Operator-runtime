import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RelayHub } from '../src/relay-hub.ts';

test('relay public health does not disclose live device occupancy', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-relay-health-'));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const hub = new RelayHub({ stateDir });
  t.after(() => hub.close());
  const bound = await hub.listen('127.0.0.1', 0);
  const response = await fetch(`http://127.0.0.1:${bound.port}/health`);
  assert.equal(response.status, 200);
  const body = await response.json() as Record<string, unknown>;
  assert.equal(body.ok, true);
  assert.equal(body.service, 'operator-relay');
  assert.equal('onlineDevices' in body, false);
});
