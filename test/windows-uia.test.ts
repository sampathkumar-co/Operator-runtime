import assert from 'node:assert/strict';
import test from 'node:test';
import { WindowsUiaProvider } from '../src/capabilities/windows-uia.ts';

const provenance = { kind: 'chatgpt' as const };

test('Windows UIA provider is platform-gated', () => {
  const provider = new WindowsUiaProvider({ platform: 'linux' });
  assert.equal(provider.supports({ id: 'i1', capability: 'app.inspect', risk: 'read', input: {}, provenance }), false);
  assert.equal(provider.supports({ id: 'o1', capability: 'app.operate', risk: 'external', input: {}, provenance }), false);
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
