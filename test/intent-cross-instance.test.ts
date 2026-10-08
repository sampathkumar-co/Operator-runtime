import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { IntentKernel } from '../src/core/intent-kernel.ts';

test('independent intent kernels preserve all supersession versions and their digest chain', async (t) => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-intent-concurrent-'));
  t.after(() => fs.rm(state, { recursive: true, force: true }));
  const kernels = Array.from({ length: 8 }, () => new IntentKernel(state, 'shared-conversation'));
  const updated = await Promise.all(Array.from({ length: 24 }, (_, i) =>
    kernels[i % kernels.length]!.update({
      objective: 'Requirement version ' + i,
      directive: i % 3 === 0 ? 'revoke' : i % 3 === 1 ? 'continue' : 'refine',
      sourceTurnId: 'turn-' + i
    })
  ));
  const ordered = [...updated].sort((a,b) => a.intentVersion - b.intentVersion);
  assert.deepEqual(ordered.map((e) => e.intentVersion), Array.from({length: 24}, (_,i) => i+1));
  assert.equal(new Set(ordered.map((e) => e.digest)).size, 24);
  assert.equal(ordered[0]?.previousIntentDigest, undefined);
  for (let i=1;i<ordered.length;i++) {
    assert.equal(ordered[i]?.previousIntentDigest, ordered[i-1]?.digest);
  }
  const fresh = await new IntentKernel(state, 'shared-conversation').current();
  assert.equal(fresh?.intentVersion, 24);
  assert.equal(fresh?.digest, ordered[23]!.digest);
  await kernels[0]!.assertCurrent(fresh!.intentVersion, fresh!.digest);
  for (const old of ordered.slice(0, -1)) {
    await assert.rejects(kernels[1]!.assertCurrent(old.intentVersion, old.digest),
      (error: any) => error?.code === 'INTENT_STALE');
  }
  const separate = new IntentKernel(state, 'unrelated-conversation');
  const unrelated = await separate.update({objective:'Unrelated intent',directive:'continue',sourceTurnId:'turn-independent'});
  assert.equal(unrelated.intentVersion, 1);
  assert.equal((await kernels[3]!.current())?.intentVersion, 24);
});
