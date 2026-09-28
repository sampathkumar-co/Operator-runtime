import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { IntentKernel } from '../src/core/intent-kernel.ts';

async function temp(t: test.TestContext): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-intent-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('new intent versions supersede old execution authority', async (t) => {
  const kernel = new IntentKernel(await temp(t), 'chat-1');
  const v1 = await kernel.update({
    objective: 'Fix the bug and deploy.',
    authorizedScope: ['repo'],
    prohibitedScope: [],
    directive: 'continue',
    sourceTurnId: 'turn-1'
  });
  const v2 = await kernel.update({
    objective: 'Fix the bug but do not deploy.',
    authorizedScope: ['repo'],
    prohibitedScope: ['deploy'],
    directive: 'revoke',
    sourceTurnId: 'turn-2'
  });
  assert.equal(v2.intentVersion, v1.intentVersion + 1);
  await assert.rejects(() => kernel.assertCurrent(v1.intentVersion, v1.digest), (error: any) => error?.code === 'INTENT_STALE');
  assert.equal((await kernel.assertCurrent(v2.intentVersion, v2.digest)).objective, 'Fix the bug but do not deploy.');
});

test('intent chain binds each version to the previous digest', async (t) => {
  const kernel = new IntentKernel(await temp(t), 'chat-2');
  const first = await kernel.update({
    objective: 'Inspect only.',
    directive: 'continue',
    sourceTurnId: 'turn-a'
  });
  const second = await kernel.update({
    objective: 'Inspect and report.',
    directive: 'refine',
    sourceTurnId: 'turn-b'
  });
  assert.equal(second.previousIntentDigest, first.digest);
  assert.match(second.digest, /^[0-9a-f]{64}$/);
});
