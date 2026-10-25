import assert from 'node:assert/strict';
import test from 'node:test';
import { WindowsUiaProvider } from '../src/capabilities/windows-uia.ts';
import { OperatorError } from '../src/core/errors.ts';

const provenance = { kind: 'chatgpt' as const };

test('Windows UIA provider is platform-gated', () => {
  const provider = new WindowsUiaProvider({ platform: 'linux' });
  assert.equal(provider.supports({ id: 'i1', capability: 'app.inspect', risk: 'read', input: {}, provenance }), false);
  assert.equal(provider.supports({ id: 'o1', capability: 'app.operate', risk: 'external', input: {}, provenance }), false);
  assert.equal(provider.supports({ id: 'v1', capability: 'visual.capture', risk: 'read', input: {}, provenance }), false);
  assert.equal(provider.supports({ id: 'p1', capability: 'input.operate', risk: 'external', input: {}, provenance }), false);
  provider.close();
});

test('aborted UIA execution fails before sidecar launch', async () => {
  const provider = new WindowsUiaProvider({ platform: 'win32', binaryPath: '/definitely/missing/operator-windows-uia.exe' });
  const controller = new AbortController();
  controller.abort();
  const result = await provider.execute({
    id: 'aborted-uia',
    capability: 'app.inspect',
    risk: 'read',
    provenance,
    input: {}
  }, { signal: controller.signal });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'EXECUTION_ABORTED');
  provider.close();
});

test('invalid UIA operation fails before sidecar launch', async () => {
  const provider = new WindowsUiaProvider({ platform: 'win32', binaryPath: '/definitely/missing/operator-windows-uia.exe' });
  const result = await provider.execute({
    id: 'bad-op',
    capability: 'app.operate',
    risk: 'external',
    provenance,
    input: {
      operation: 'run_script',
      selector: { automationId: 'save-button' }
    }
  });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'INVALID_UIA_OPERATION');
  provider.close();
});

test('scroll requires a bounded semantic amount before sidecar launch', async () => {
  const provider = new WindowsUiaProvider({ platform: 'win32', binaryPath: '/definitely/missing/operator-windows-uia.exe' });
  const missing = await provider.execute({
    id: 'missing-scroll',
    capability: 'app.operate',
    risk: 'external',
    provenance,
    input: {
      operation: 'scroll',
      selector: { automationId: 'list' }
    }
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.error?.code, 'INVALID_UIA_SCROLL_AMOUNT');

  const arbitrary = await provider.execute({
    id: 'bad-scroll',
    capability: 'app.operate',
    risk: 'external',
    provenance,
    input: {
      operation: 'scroll',
      selector: { automationId: 'list' },
      verticalAmount: '999999'
    }
  });
  assert.equal(arbitrary.ok, false);
  assert.equal(arbitrary.error?.code, 'INVALID_UIA_SCROLL_AMOUNT');
  provider.close();
});

test('activate_window is a closed semantic operation rather than a raw-handle API', async () => {
  const provider = new WindowsUiaProvider({ platform: 'win32', binaryPath: '/definitely/missing/operator-windows-uia.exe' });
  const result = await provider.execute({
    id: 'activate-window',
    capability: 'app.operate',
    risk: 'external',
    provenance,
    input: {
      operation: 'activate_window',
      selector: { automationId: 'main-window' },
      windowId: '0xDEADBEEF'
    }
  });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'UIA_SIDECAR_START_FAILED');
  provider.close();
});


test('physical input requires a live SHA-bound visual capture lease before sidecar dispatch', async () => {
  const provider = new WindowsUiaProvider({ platform: 'win32', binaryPath: '/definitely/missing/operator-windows-uia.exe' });
  assert.equal(provider.supports({ id: 'p2', capability: 'input.operate', risk: 'external', input: {}, provenance }), true);
  const result = await provider.execute({
    id: 'no-capture-lease',
    capability: 'input.operate',
    risk: 'external',
    provenance,
    input: {
      operation: 'click',
      captureId: 'missing-capture',
      expectedSha256: 'a'.repeat(64),
      x: 10,
      y: 10
    }
  });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'INPUT_CAPTURE_STALE');
  provider.close();
});

test('visual capture remains a Windows-only provider capability', () => {
  const windows = new WindowsUiaProvider({ platform: 'win32', binaryPath: '/definitely/missing/operator-windows-uia.exe' });
  assert.equal(windows.supports({ id: 'v2', capability: 'visual.capture', risk: 'read', input: {}, provenance }), true);
  windows.close();
});

test('visual capture emits Observation V3 rendered evidence and target-local after evidence', async () => {
  const before = Buffer.alloc(32, 1).toString('base64');
  const after = Buffer.alloc(32, 2).toString('base64');
  let captureCalls = 0;
  const provider = new WindowsUiaProvider({
    platform: 'win32',
    client: {
      async call(method) {
        if (method === 'input') return { dispatched: true };
        assert.equal(method, 'capture');
        captureCalls += 1;
        return {
          png_base64: captureCalls < 3 ? before : after,
          source: 'region', origin_x: -200, origin_y: 50,
          source_width: 400, source_height: 200,
          returned_width: 200, returned_height: 100,
          scale_x: 2, scale_y: 2, window_id: '0xABC'
        };
      },
      close() {}
    }
  });
  const capture = await provider.execute({
    id: 'roi-capture', capability: 'visual.capture', risk: 'read', provenance,
    input: {
      source: 'region', region: { x: -200, y: 50, width: 400, height: 200 },
      evidenceTier: 'target-roi', targetAssociation: 'uia:save'
    }
  });
  assert.equal(capture.ok, true);
  const captureOutput = capture.output as any;
  assert.equal(captureOutput.renderedEvidence.tier, 'target-roi');
  assert.equal(captureOutput.renderedEvidence.sceneKey, 'desktop:window:0xabc');
  assert.equal(captureOutput.renderedEvidence.targetAssociation, 'uia:save');
  assert.equal(captureOutput.renderedEvidence.transform.originX, -200);

  const operated = await provider.execute({
    id: 'roi-click', capability: 'input.operate', risk: 'external', provenance,
    input: {
      operation: 'click', captureId: captureOutput.captureId,
      expectedSha256: captureOutput.sha256, x: 20, y: 10
    }
  });
  assert.equal(operated.ok, true);
  const operation = operated.output as any;
  assert.equal(operation.renderedDelta.scope, 'target-local');
  assert.equal(operation.renderedDelta.changed, true);
  assert.equal(operation.postcondition.regionStable, true);
  provider.close();
});

test('mutating UIA transport timeout is uncertain and is never replayed after late success', async () => {
  let calls = 0;
  let lateSuccess = false;
  const provider = new WindowsUiaProvider({
    platform: 'win32',
    client: {
      async call() {
        calls += 1;
        setImmediate(() => { lateSuccess = true; });
        throw new OperatorError('UIA_SIDECAR_TIMEOUT', 'operate timed out', { retryable: true });
      },
      close() {}
    }
  });
  const result = await provider.execute({
    id: 'late-operate', capability: 'app.operate', risk: 'external', provenance,
    input: { operation: 'invoke', selector: { automationId: 'save' } }
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lateSuccess, true);
  assert.equal(calls, 1);
  assert.equal(result.error?.sideEffectState, 'uncertain');
  assert.equal(result.error?.retryable, false);
});

test('Windows UIA emergency lifecycle awaits sidecar shutdown', async () => {
  let closed = false;
  const provider = new WindowsUiaProvider({
    platform: 'win32',
    client: {
      async call() { return {}; },
      async close() { await new Promise((resolve) => setTimeout(resolve, 20)); closed = true; }
    }
  });
  await provider.emergencyStop();
  assert.equal(closed, true);
});

test('C04 UIA mutation dispatch rejects unscoped, truncated and malformed semantic targets', async () => {
  let sidecarCalls = 0;
  const provider = new WindowsUiaProvider({
    platform: 'win32',
    client: { async call() { sidecarCalls++; return {}; }, close() {} }
  });
  const selector = { automationId: 'save-button' };
  const cases: Array<{ input: Record<string, unknown>; code: string }> = [
    { input: { operation: 'invoke' }, code: 'INVALID_UIA_SELECTOR' },
    { input: { operation: 'invoke', selector: {} }, code: 'INVALID_UIA_SELECTOR' },
    { input: { operation: 'invoke', selector: { automationId: 'x'.repeat(513) } }, code: 'INVALID_UIA_SELECTOR' },
    { input: { operation: 'invoke', selector: { processId: 9_999_999_999 } }, code: 'INVALID_UIA_SELECTOR' },
    { input: { operation: { toString: () => 'invoke' }, selector }, code: 'INVALID_UIA_OPERATION' },
    { input: { operation: 'set_value', selector }, code: 'INVALID_UIA_VALUE' },
    { input: { operation: 'set_value', selector, value: { toString: () => 'private-value' } }, code: 'INVALID_UIA_VALUE' },
    { input: { operation: 'set_value', selector, value: 'x'.repeat(65_537) }, code: 'INVALID_UIA_VALUE' },
    { input: { operation: 'set_value', selector, value: 'prefix' + String.fromCharCode(0) + 'suffix' }, code: 'INVALID_UIA_VALUE' }
  ];
  for (let index = 0; index < cases.length; index++) {
    const { input, code } = cases[index]!;
    const result = await provider.execute({
      id: 'uia-target-boundary-' + index,
      capability: 'app.operate', risk: 'external', input, provenance
    });
    assert.equal(result.ok, false, String(index));
    assert.equal(result.error?.code, code, String(index));
  }
  assert.equal(sidecarCalls, 0, 'invalid selectors must never reach the native helper');
  await provider.close();
});

test('C04 exact bounded UIA selector still permits an explicitly scoped semantic operation', async () => {
  const calls: Array<{ method: string; params: unknown }> = [];
  const provider = new WindowsUiaProvider({
    platform: 'win32',
    client: {
      async call(method: string, params: unknown) {
        calls.push({ method, params });
        return { verified: true };
      },
      close() {}
    }
  });
  const result = await provider.execute({
    id: 'uia-valid-target',
    capability: 'app.operate', risk: 'external', provenance,
    input: { operation: 'set_value', selector: { automationId: 'target-value' }, value: 'নমস্কার' }
  });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.method, 'operate');
  assert.equal((calls[0]!.params as any).selector.automation_id, 'target-value');
  assert.equal((calls[0]!.params as any).value, 'নমস্কার');
  await provider.close();
});

test('C08 mutating UIA transport-write and post-input capture failures cannot be automatically replayed', async () => {
  for (const code of ['UIA_SIDECAR_WRITE_FAILED', 'UIA_OPERATION_FAILED',
    'INPUT_AFTER_CAPTURE_FAILED', 'INPUT_AFTER_CAPTURE_INVALID']) {
    let calls = 0;
    const provider = new WindowsUiaProvider({
      platform: 'win32',
      client: {
        async call() {
          calls += 1;
          throw new OperatorError(code, 'Native operation may have been dispatched', { retryable: true });
        },
        close() {}
      }
    });
    const result = await provider.execute({
      id: 'uncertain-uia-' + code, capability: 'app.operate', risk: 'external', provenance,
      input: { operation: 'invoke', selector: { automationId: 'save' } }
    });
    assert.equal(calls, 1, code);
    assert.equal(result.error?.sideEffectState, 'uncertain', code);
    assert.equal(result.error?.retryable, false, code);
    await provider.close();
  }
});

test('C10 Windows native helper errors cannot export secret-bearing stderr or target details', async () => {
  const secret='PRIVATE_DEVICE_TOKEN_DO_NOT_EXPORT';
  const provider=new WindowsUiaProvider({
    platform:'win32',
    client:{
      async call(){throw new OperatorError('UIA_SIDECAR_EXITED',
        'native stderr password=' + secret + ' path=C:\\Users\\private', {retryable:true});},
      close(){}
    }
  });
  const result=await provider.execute({
    id:'uia-privacy-boundary',capability:'app.operate',risk:'external',provenance,
    input:{operation:'invoke',selector:{automationId:'login'}}
  });
  assert.equal(result.ok,false);
  assert.equal(result.error?.code,'UIA_SIDECAR_EXITED');
  assert.equal(result.error?.sideEffectState,'uncertain');
  assert.equal(result.error?.retryable,false);
  assert.equal(JSON.stringify(result).includes(secret),false);
  assert.equal(JSON.stringify(result).includes('Users'),false);
  await provider.close();
});

test('C04 UIA mutation cannot silently ignore unknown selector identity constraints', async () => {
  const provider=new WindowsUiaProvider({
    platform:'win32',
    client:{async call(){throw Error('Native helper must not be reached');},close(){}}
  });
  const result=await provider.execute({
    id:'uia-extra-selector',capability:'app.operate',risk:'external',provenance,
    input:{operation:'invoke',selector:{automationId:'save',unexpectedTarget:'another-window'}}
  });
  assert.equal(result.ok,false);
  assert.equal(result.error?.code,'INVALID_UIA_SELECTOR');
  await provider.close();
});
