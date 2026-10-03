import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PerceptionGraphStore } from '../src/core/perception-graph.ts';
import { publishPerceptionFromActionResult } from '../src/core/perception-publication.ts';

async function temp(t: test.TestContext): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-perception-publication-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('stage11 UIA publication preserves geometry but drops editable control values', async (t) => {
  const dir = await temp(t);
  const graph = new PerceptionGraphStore(dir);
  const published = await publishPerceptionFromActionResult(graph, {
    id: 'inspect',
    capability: 'app.inspect',
    risk: 'read',
    provenance: { kind: 'runtime' },
    input: {}
  }, {
    ok: true,
    capability: 'app.inspect',
    provider: 'windows.uia',
    output: {
      elements: [{
        name: 'Password',
        automation_id: 'password-box',
        class_name: 'Edit',
        control_type: 'Edit',
        process_id: 42,
        depth: 2,
        bounds: { x: 100, y: 200, width: 240, height: 32 },
        patterns: { value: true },
        value: 'super-secret-value',
        selected: false
      }]
    },
    evidence: [],
    durationMs: 1
  });
  assert.equal(published, 1);
  const scene = await graph.scene('uia:process:42');
  assert.equal(scene.length, 1);
  assert.deepEqual(scene[0]!.bounds, { x: 100, y: 200, width: 240, height: 32 });
  assert.equal(scene[0]!.name, 'Password');
  const raw = await fs.readFile(path.join(dir, 'perception-graph.json'), 'utf8');
  assert.equal(raw.includes('super-secret-value'), false);
});

test('stage11 visual capture publication persists metadata and never image bytes', async (t) => {
  const dir = await temp(t);
  const graph = new PerceptionGraphStore(dir);
  const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';
  const published = await publishPerceptionFromActionResult(graph, {
    id: 'capture',
    capability: 'visual.capture',
    risk: 'read',
    provenance: { kind: 'runtime' },
    input: { source: 'screen' }
  }, {
    ok: true,
    capability: 'visual.capture',
    provider: 'windows.uia',
    output: {
      captureId: 'capture-stage11',
      sha256: 'b'.repeat(64),
      source: 'screen',
      width: 960,
      height: 540,
      imageBase64: image
    },
    evidence: [],
    durationMs: 1
  });
  assert.equal(published, 1);
  const scene = await graph.scene('visual:screen');
  assert.equal(scene.length, 1);
  assert.deepEqual(scene[0]!.bounds, { x: 0, y: 0, width: 960, height: 540 });
  const raw = await fs.readFile(path.join(dir, 'perception-graph.json'), 'utf8');
  assert.equal(raw.includes(image), false);
  assert.equal(raw.includes('capture-stage11'), true);
  assert.equal(raw.includes('b'.repeat(64)), true);
});

test('UIA runtime identity survives geometry changes and shares its window scene with captures', async (t) => {
  const graph = new PerceptionGraphStore(await temp(t));
  const action = { id: 'inspect', capability: 'app.inspect', risk: 'read' as const, provenance: { kind: 'runtime' as const }, input: {} };
  const result = (x: number) => ({
    ok: true as const,
    capability: 'app.inspect',
    provider: 'windows.uia',
    output: { elements: [{
      name: 'Save', automation_id: 'save', class_name: 'Button', control_type: 'Button',
      process_id: 42, runtime_id: [42, 7, 9], window_id: '0x2A', depth: 2,
      bounds: { x, y: 20, width: 100, height: 30 }
    }] },
    evidence: [], durationMs: 1
  });
  await publishPerceptionFromActionResult(graph, action, result(10));
  await publishPerceptionFromActionResult(graph, action, result(300));
  await publishPerceptionFromActionResult(graph, {
    id: 'capture', capability: 'visual.capture', risk: 'read', provenance: { kind: 'runtime' }, input: {}
  }, {
    ok: true, capability: 'visual.capture', provider: 'windows.uia', evidence: [], durationMs: 1,
    output: {
      captureId: 'capture-window', sha256: 'c'.repeat(64), source: 'window', windowId: '0x2a',
      originX: 100, originY: 50, sourceWidth: 800, sourceHeight: 600,
      width: 400, height: 300, scaleX: 2, scaleY: 2
    }
  });

  const scene = await graph.scene('desktop:window:0x2a');
  const save = scene.find((target) => target.name === 'Save');
  const capture = scene.find((target) => target.role === 'capture');
  assert.ok(save);
  assert.equal(save.node.claims.length, 1);
  assert.deepEqual(save.bounds, { x: 300, y: 20, width: 100, height: 30 });
  assert.ok(capture);
  assert.deepEqual(capture.coordinates, {
    from: 'capture-image', to: 'native-screen', originX: 100, originY: 50,
    scaleX: 2, scaleY: 2, sourceWidth: 400, sourceHeight: 300,
    targetWidth: 800, targetHeight: 600, generation: 'c'.repeat(64),
    provenance: 'windows.uia:visual.capture:capture-window'
  });
});
