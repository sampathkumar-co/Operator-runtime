import assert from 'node:assert/strict';
import test from 'node:test';
import { WindowsUiaProvider } from '../src/capabilities/windows-uia.ts';

function nativeCapture(bytes: Buffer, source = 'region', windowId = '0xABC') {
  return {
    source,
    png_base64: bytes.toString('base64'),
    origin_x: 0, origin_y: 0,
    source_width: 400, source_height: 300,
    returned_width: 400, returned_height: 300,
    scale_x: 1, scale_y: 1,
    window_id: windowId
  };
}

test('C04 post-input native scope/window mismatch never persists foreign screenshot or permits replay', async () => {
  const before = Buffer.alloc(128, 1);
  const after = Buffer.alloc(160 * 1024, 2);
  const variants = [
    { source: 'screen', windowId: '0xABC', code: 'INPUT_AFTER_SOURCE_CHANGED' },
    { source: 'region', windowId: '0xFOREIGN', code: 'INPUT_AFTER_WINDOW_CHANGED' }
  ];

  for (const variant of variants) {
    let captureCalls = 0;
    let inputCalls = 0;
    let artifactWrites = 0;
    const provider = new WindowsUiaProvider({
      platform: 'win32',
      artifactStore: {
        async put() {
          artifactWrites++;
          throw new Error('Foreign screenshot must never be stored.');
        }
      } as any,
      client: {
        async call(method: string) {
          if (method === 'input') { inputCalls++; return { operation: 'click', postcondition: { dispatched: true, foreground: true } }; }
          assert.equal(method, 'capture');
          captureCalls++;
          return captureCalls <= 2
            ? nativeCapture(before)
            : nativeCapture(after, variant.source, variant.windowId);
        },
        close() {}
      }
    });

    try {
      const observation = await provider.execute({
        id: 'pre-' + variant.code, capability: 'visual.capture', risk: 'read',
        provenance: { kind: 'runtime' },
        input: { source: 'region', region: { x: 0, y: 0, width: 400, height: 300 } }
      } as any);
      assert.equal(observation.ok, true);
      const observed = observation.output as { captureId: string; sha256: string };
      const result = await provider.execute({
        id: 'post-' + variant.code, capability: 'input.operate', risk: 'external',
        provenance: { kind: 'runtime' },
        input: {
          operation: 'click', captureId: observed.captureId,
          expectedSha256: observed.sha256, x: 50, y: 50
        }
      } as any);
      assert.equal(inputCalls, 1, 'One physical mutation has already happened.');
      assert.equal(captureCalls, 3, 'Post-input state is independently recaptured.');
      assert.equal(result.ok, false, 'Changed observation identity cannot prove success.');
      assert.equal(result.error?.code, variant.code);
      assert.equal(result.error?.retryable, false);
      assert.equal(result.error?.sideEffectState, 'uncertain');
      assert.equal(result.output, undefined);
      assert.equal(artifactWrites, 0, 'Captured foreign pixels must not be persisted.');
      assert.equal(JSON.stringify(result).includes(after.toString('base64').slice(0,90)), false);
    } finally {
      await provider.close();
    }
  }
});

test('C04 unchanged pixels cannot authorize input after source, window or geometry changes', async () => {
  const bytes = Buffer.alloc(128, 7);
  const variants = [
    { name: 'source', modified: { source: 'screen' } },
    { name: 'window', modified: { window_id: '0xDEF' } },
    { name: 'origin', modified: { origin_x: 1 } },
    { name: 'scale', modified: { scale_x: 1.25 } },
    { name: 'source width', modified: { source_width: 401 } },
    { name: 'returned height', modified: { returned_height: 299 } }
  ];
  for (const variant of variants) {
    let captures = 0;
    let inputs = 0;
    const provider = new WindowsUiaProvider({
      platform: 'win32',
      client: {
        async call(method: string) {
          if (method === 'input') { inputs++; return { operation: 'click', postcondition: { dispatched: true, foreground: true } }; }
          captures++;
          return {
            ...nativeCapture(bytes),
            ...(captures === 1 ? {} : variant.modified)
          };
        },
        close() {}
      }
    });
    try {
      const captured = await provider.execute({
        id: 'before-' + variant.name, capability: 'visual.capture', risk: 'read',
        provenance: { kind: 'runtime' },
        input: { source: 'region', region: { x: 0, y: 0, width: 400, height: 300 } }
      } as any);
      assert.equal(captured.ok, true);
      const output = captured.output as { captureId: string; sha256: string };
      const result = await provider.execute({
        id: 'action-' + variant.name, capability: 'input.operate', risk: 'external',
        provenance: { kind: 'runtime' },
        input: {
          operation: 'click', captureId: output.captureId,
          expectedSha256: output.sha256, x: 20, y: 20
        }
      } as any);
      assert.equal(captures, 2, variant.name + ': recaptured before input');
      assert.equal(inputs, 0, variant.name + ': did not dispatch physical input');
      assert.equal(result.ok, false, variant.name);
      assert.equal(result.error?.code, 'INPUT_CAPTURE_STALE', variant.name);
    } finally {
      await provider.close();
    }
  }
});

test('C04 capture refuses pixels outside the exact requested region or missing window identity', async () => {
  const bytes = Buffer.alloc(160 * 1024, 9);
  const variants = [
    {
      name: 'wrong region origin',
      input: { source: 'region', region: { x: 0, y: 0, width: 400, height: 300 } },
      native: { ...nativeCapture(bytes), origin_x: 7 }
    },
    {
      name: 'wrong region size',
      input: { source: 'region', region: { x: 0, y: 0, width: 400, height: 300 } },
      native: { ...nativeCapture(bytes), source_width: 500 }
    },
    {
      name: 'unidentified window',
      input: { source: 'window', selector: { name: 'Contract App' } },
      native: { ...nativeCapture(bytes, 'window', ''), window_id: '' }
    }
  ];
  for (const variant of variants) {
    let artifactWrites = 0;
    const provider = new WindowsUiaProvider({
      platform: 'win32',
      artifactStore: {
        async put() { artifactWrites++; throw new Error('Unexpected persistence of out-of-scope pixels'); }
      } as any,
      client: { async call() { return variant.native; }, close() {} }
    });
    try {
      const result = await provider.execute({
        id: 'capture-' + variant.name, capability: 'visual.capture', risk: 'read',
        provenance: { kind: 'runtime' }, input: variant.input
      } as any);
      assert.equal(result.ok, false, variant.name);
      assert.equal(result.error?.code, 'VISUAL_CAPTURE_INVALID', variant.name);
      assert.equal(result.error?.sideEffectState, 'none', variant.name);
      assert.equal(result.output, undefined, variant.name);
      assert.equal(artifactWrites, 0, variant.name);
    } finally {
      await provider.close();
    }
  }
});
