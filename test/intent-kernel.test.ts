import assert from 'node:assert/strict';
import crypto from 'node:crypto';
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

test('intent file refuses valid authority copied from another conversation', async (t) => {
  const dir = await temp(t);
  const source = new IntentKernel(dir, 'source-conversation');
  const target = new IntentKernel(dir, 'target-conversation');
  const original = await source.update({
    objective: 'Inspect only within the source conversation.',
    directive: 'continue',
    sourceTurnId: 'source-turn'
  });
  await fs.mkdir(path.join(dir, 'intent'), { recursive: true });
  await fs.copyFile(
    path.join(dir, 'intent', 'source-conversation.json'),
    path.join(dir, 'intent', 'target-conversation.json')
  );
  await assert.rejects(target.current(), (error: any) => error?.code === 'INTENT_STATE_CORRUPT');
  await assert.rejects(
    target.assertCurrent(original.intentVersion, original.digest),
    (error: any) => error?.code === 'INTENT_STATE_CORRUPT'
  );
  await assert.rejects(
    target.update({ objective: 'Must not inherit other conversation authority.', directive: 'continue', sourceTurnId: 'target-turn' }),
    (error: any) => error?.code === 'INTENT_STATE_CORRUPT'
  );
  assert.equal((await source.current())?.conversationId, 'source-conversation');
});

test('intent version exhaustion fails closed without writing an invalid successor', async (t) => {
  const dir = await temp(t);
  const kernel = new IntentKernel(dir, 'version-limit');
  await kernel.update({ objective: 'Pinned version', directive: 'continue', sourceTurnId: 'turn-1' });
  const file = path.join(dir, 'intent', 'version-limit.json');
  const original = JSON.parse(await fs.readFile(file, 'utf8'));
  const { digest: _old, ...base } = original;
  base.intentVersion = Number.MAX_SAFE_INTEGER;
  const exhausted = {
    ...base,
    digest: crypto.createHash('sha256').update(JSON.stringify(base)).digest('hex')
  };
  await fs.writeFile(file, JSON.stringify(exhausted, null, 2));
  const before = await fs.readFile(file, 'utf8');
  assert.equal((await kernel.current())?.intentVersion, Number.MAX_SAFE_INTEGER);
  await assert.rejects(
    kernel.update({ objective: 'Do not roll over.', directive: 'continue', sourceTurnId: 'turn-2' }),
    (error: any) => error?.code === 'INTENT_VERSION_EXHAUSTED'
  );
  assert.equal(await fs.readFile(file, 'utf8'), before);
});
