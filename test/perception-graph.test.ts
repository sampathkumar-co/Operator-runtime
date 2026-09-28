import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PerceptionGraphStore, perceptionDigest } from '../src/core/perception-graph.ts';

async function temp(t: test.TestContext): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-perception-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('stage11 fuses UIA and visual claims into one stable grounded target', async (t) => {
  const graph = new PerceptionGraphStore(await temp(t));
  const sceneKey = 'desktop:window:editor';
  await graph.observe({
    sceneKey,
    channel: 'uia',
    source: 'windows.uia',
    semanticId: 'automation:export-button',
    role: 'button',
    name: 'Export',
    bounds: { x: 100, y: 200, width: 120, height: 40 },
    state: { enabled: true },
    confidence: 0.99,
    evidenceDigest: perceptionDigest('uia')
  });
  await graph.observe({
    sceneKey,
    channel: 'visual',
    source: 'vision-model',
    role: 'button',
    name: 'Export',
    bounds: { x: 102, y: 201, width: 118, height: 39 },
    state: { visible: true },
    confidence: 0.9,
    evidenceDigest: perceptionDigest('visual')
  });

  const scene = await graph.scene(sceneKey);
  assert.equal(scene.length, 1);
  assert.deepEqual(scene[0]?.channels, ['uia', 'visual']);
  const grounded = await graph.ground({ sceneKey, semanticId: 'automation:export-button' });
  assert.equal(grounded.name, 'Export');
  assert.ok(grounded.confidence > 0.99);
});

test('stage11 fails closed on ambiguous targets rather than selecting by coordinates', async (t) => {
  const graph = new PerceptionGraphStore(await temp(t));
  const sceneKey = 'desktop:window:ambiguous';
  for (const x of [10, 300]) {
    await graph.observe({
      sceneKey,
      channel: 'visual',
      source: `vision-${x}`,
      role: 'button',
      name: 'OK',
      bounds: { x, y: 10, width: 80, height: 30 },
      state: {},
      confidence: 0.9,
      evidenceDigest: perceptionDigest(x)
    });
  }
  await assert.rejects(
    () => graph.ground({ sceneKey, role: 'button', name: 'OK' }),
    (error: any) => error?.code === 'PERCEPTION_TARGET_AMBIGUOUS'
  );
});

test('stage11 rejects secret-bearing observation state', async (t) => {
  const graph = new PerceptionGraphStore(await temp(t));
  await assert.rejects(
    () => graph.observe({
      sceneKey: 'browser:1',
      channel: 'dom',
      source: 'browser.cdp',
      semanticId: 'input',
      role: 'textbox',
      state: { authToken: 'do-not-store' },
      confidence: 1,
      evidenceDigest: perceptionDigest('secret')
    }),
    (error: any) => error?.code === 'PERCEPTION_SECRET_REJECTED'
  );
});
