import assert from 'node:assert/strict';
import test from 'node:test';
import {
  strictPhysicalInputOperation,
  strictNativeInputResult,
  strictNativeCaptureBase64,
  WindowsUiaProvider
} from '../src/capabilities/windows-uia.ts';

test('C04 physical operations require literal operation strings, never coerced names', () => {
  for (const operation of ['move', 'click', 'double_click', 'drag', 'scroll', 'type_text', 'key_press', 'hotkey']) {
    assert.equal(strictPhysicalInputOperation(operation), operation);
  }
  let coerced = 0;
  for (const invalid of [
    ['click'], { toString() { coerced++; return 'click'; } },
    null, undefined, true, 1, new String('click'), 'CLICK', ' click', ''
  ]) {
    assert.throws(() => strictPhysicalInputOperation(invalid),
      (error: any) => error?.code === 'INPUT_OPERATION_INVALID');
  }
  assert.equal(coerced, 0);
});

test('C04 native screenshot payload must be a literal bounded string in all capture phases', () => {
  const base64 = Buffer.alloc(32, 1).toString('base64');
  for (const phase of ['initial', 'before_input', 'after_input'] as const) {
    assert.equal(strictNativeCaptureBase64(base64, phase), base64);
    const code = phase === 'initial' ? 'VISUAL_CAPTURE_INVALID'
      : phase === 'before_input' ? 'INPUT_CAPTURE_INVALID' : 'INPUT_AFTER_CAPTURE_INVALID';
    for (const invalid of [[base64], { toString() { return base64; } }, null, false, '', 'a'.repeat(4 * 1024 * 1024 + 1)]) {
      assert.throws(() => strictNativeCaptureBase64(invalid, phase),
        (error: any) => error?.code === code);
    }
  }
});

test('C04 a non-string native screenshot never becomes an authorized pointer capture lease', async () => {
  let calls = 0;
  const provider = new WindowsUiaProvider({
    platform: 'win32',
    client: {
      async call(method) {
        calls++;
        assert.equal(method, 'capture');
        return { png_base64: [Buffer.alloc(32, 1).toString('base64')], source: 'screen' };
      },
      close() {}
    }
  });
  try {
    const captured = await provider.execute({
      id: 'non-literal-capture', capability: 'visual.capture', risk: 'read',
      input: { source: 'screen' }, provenance: { kind: 'runtime' }
    });
    assert.equal(captured.ok, false);
    assert.equal(captured.error?.code, 'VISUAL_CAPTURE_INVALID');
    assert.equal(calls, 1);
    const physical = await provider.execute({
      id: 'no-leased-physical-target', capability: 'input.operate', risk: 'external',
      input: { operation: 'click', captureId: 'unissued', expectedSha256: 'a'.repeat(64), x: 2, y: 3 },
      provenance: { kind: 'runtime' }
    });
    assert.equal(physical.ok, false);
    assert.equal(physical.error?.code, 'INPUT_CAPTURE_STALE');
    assert.equal(calls, 1, 'physical input cannot reach native helper without a valid capture lease');
  } finally { await provider.close(); }
});

test('C04 native physical input results must confirm exact operation, dispatch and capture window scope', () => {
  const valid = { operation: 'click', postcondition: { dispatched: true, foreground: true } };
  assert.deepEqual(strictNativeInputResult(valid, 'click', true), valid);
  for (const invalid of [
    null, true, [], {},
    { ...valid, operation: ['click'] },
    { ...valid, operation: 'hotkey' },
    { ...valid, postcondition: { dispatched: 'true', foreground: true } },
    { ...valid, postcondition: { dispatched: true, foreground: false } },
    { ...valid, postcondition: { dispatched: true, foreground: ['true'] } }
  ]) {
    assert.throws(() => strictNativeInputResult(invalid, 'click', true),
      (error: any) => error?.code === 'INPUT_NATIVE_RESULT_INVALID');
  }
});

test('C04 response loss consumes capture lease before dispatch and refuses physical input replay', async () => {
  const image = Buffer.alloc(128, 7).toString('base64');
  let inputCalls = 0;
  const provider = new WindowsUiaProvider({
    platform: 'win32',
    client: {
      async call(method) {
        if (method === 'input') {
          inputCalls++;
          throw new Error('simulated native response lost after input may have occurred');
        }
        return {
          source: 'region', png_base64: image,
          origin_x: 0, origin_y: 0, source_width: 100, source_height: 100,
          returned_width: 100, returned_height: 100, scale_x: 1, scale_y: 1,
          window_id: 'window-fixture'
        };
      },
      close() {}
    }
  });
  try {
    const before = await provider.execute({
      id: 'capture-for-response-loss', capability: 'visual.capture', risk: 'read',
      input: { source: 'region', region: { x: 0, y: 0, width: 100, height: 100 } },
      provenance: { kind: 'runtime' }
    });
    assert.equal(before.ok, true);
    const output = before.output as { captureId: string; sha256: string };
    const action = {
      capability: 'input.operate', risk: 'external' as const,
      provenance: { kind: 'runtime' as const },
      input: { operation: 'click', captureId: output.captureId, expectedSha256: output.sha256, x: 5, y: 5 }
    };
    const first = await provider.execute({ ...action, id: 'first-attempt' });
    assert.equal(first.ok, false);
    assert.equal(first.error?.sideEffectState, 'uncertain');
    const repeated = await provider.execute({ ...action, id: 'replay-attempt' });
    assert.equal(repeated.ok, false);
    assert.equal(repeated.error?.code, 'INPUT_CAPTURE_STALE');
    assert.equal(inputCalls, 1, 'native input cannot be replayed with consumed capture lease');
  } finally { await provider.close(); }
});
