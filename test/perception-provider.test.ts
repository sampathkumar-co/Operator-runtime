import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PerceptionProvider } from '../src/capabilities/perception.ts';
import { PerceptionGraphStore } from '../src/core/perception-graph.ts';

async function temp(t: test.TestContext): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-perception-provider-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('stage11 perception provider publishes bounded observations and grounds one target with center', async (t) => {
  const graph = new PerceptionGraphStore(await temp(t));
  const provider = new PerceptionProvider(graph);
  const evidenceDigest = crypto.createHash('sha256').update('visual-proof').digest('hex');
  const observed = await provider.execute({
    id: 'observe',
    capability: 'perception.observe',
    risk: 'write',
    provenance: { kind: 'chatgpt' },
    input: {
      observations: [{
        sceneKey: 'capture:c1',
        channel: 'visual',
        source: 'chatgpt.visual',
        role: 'button',
        name: 'Export',
        bounds: { x: 20, y: 30, width: 80, height: 40 },
        state: { enabled: true },
        confidence: 0.9,
        evidenceDigest
      }]
    }
  });
  assert.equal(observed.ok, true);

  const grounded = await provider.execute({
    id: 'ground',
    capability: 'perception.ground',
    risk: 'read',
    provenance: { kind: 'chatgpt' },
    input: { sceneKey: 'capture:c1', role: 'button', name: 'Export', minConfidence: 0.5 }
  });
  assert.equal(grounded.ok, true);
  assert.deepEqual((grounded.output as any).center, { x: 60, y: 50 });
  assert.deepEqual((grounded.output as any).channels, ['visual']);
});

test('stage11 perception provider fails closed on secret-bearing visual state', async (t) => {
  const graph = new PerceptionGraphStore(await temp(t));
  const provider = new PerceptionProvider(graph);
  const result = await provider.execute({
    id: 'secret',
    capability: 'perception.observe',
    risk: 'write',
    provenance: { kind: 'chatgpt' },
    input: {
      observation: {
        sceneKey: 'capture:c2',
        channel: 'visual',
        source: 'chatgpt.visual',
        role: 'textbox',
        bounds: { x: 0, y: 0, width: 10, height: 10 },
        state: { password: 'must-not-store' },
        confidence: 0.9,
        evidenceDigest: 'a'.repeat(64)
      }
    }
  });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'PERCEPTION_SECRET_REJECTED');
});
