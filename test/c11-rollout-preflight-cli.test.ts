import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readRolloutPlanFile } from '../scripts/c11-rollout-preflight-cli.mjs';

test('C11 preflight reads only a bounded, explicitly selected local file', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-c11-preflight-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const invalid = path.join(root, 'untrusted.json');
  await fs.writeFile(invalid, JSON.stringify({ schemaVersion: 1, token: 'must-not-be-projected' }));
  await assert.rejects(readRolloutPlanFile(invalid), /C11_ROLLOUT_PLAN_INVALID/);
  const huge = path.join(root, 'oversized.json');
  await fs.writeFile(huge, 'x'.repeat(70 * 1024));
  await assert.rejects(readRolloutPlanFile(huge), /C11_ROLLOUT_PLAN_FILE_INVALID/);
  await assert.rejects(readRolloutPlanFile(root), /C11_ROLLOUT_PLAN_FILE_INVALID/);
  if (process.platform !== 'win32') {
    const link = path.join(root, 'link.json');
    await fs.symlink(invalid, link);
    await assert.rejects(readRolloutPlanFile(link), /C11_ROLLOUT_PLAN_FILE_INVALID/);
  }
});
