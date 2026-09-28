import assert from 'node:assert/strict';
import test from 'node:test';
import { SandboxedComputeProvider } from '../src/capabilities/sandboxed-compute.ts';

function action(input: Record<string, unknown>) {
  return {
    id: 'compute-test',
    capability: 'compute.run',
    risk: 'write' as const,
    input,
    provenance: { kind: 'trusted_policy' as const }
  };
}

test('stage12 provider advertises only bounded compute.run capability', () => {
  const provider = new SandboxedComputeProvider();
  assert.equal(provider.supports(action({ language: 'javascript', code: '1+1' })), true);
  assert.equal(provider.supports({ ...action({}), capability: 'terminal.execute' }), false);
});

test('stage12 rejects invalid language and code before contacting Docker', async () => {
  const provider = new SandboxedComputeProvider({ dockerExecutable: 'definitely-not-used' });
  const language = await provider.execute(action({ language: 'ruby', code: 'puts 1' }));
  assert.equal(language.ok, false);
  assert.equal(language.error?.code, 'COMPUTE_LANGUAGE_INVALID');
  assert.equal(language.error?.sideEffectState, 'none');

  const code = await provider.execute(action({ language: 'javascript', code: '' }));
  assert.equal(code.ok, false);
  assert.equal(code.error?.code, 'COMPUTE_CODE_INVALID');
  assert.equal(code.error?.sideEffectState, 'none');
});

test('stage12 rejects unsafe image references at construction time', () => {
  assert.throws(
    () => new SandboxedComputeProvider({ images: { javascript: '../host-image' } }),
    (error: any) => error?.code === 'COMPUTE_IMAGE_INVALID'
  );
});

test('stage12 validates resource budgets before contacting Docker', async () => {
  const provider = new SandboxedComputeProvider({ dockerExecutable: 'definitely-not-used' });
  const tooMuchMemory = await provider.execute(action({ language: 'python', code: 'print(1)', memoryMb: 4096 }));
  assert.equal(tooMuchMemory.ok, false);
  assert.equal(tooMuchMemory.error?.code, 'COMPUTE_INPUT_INVALID');

  const tooMuchCpu = await provider.execute(action({ language: 'python', code: 'print(1)', cpu: 8 }));
  assert.equal(tooMuchCpu.ok, false);
  assert.equal(tooMuchCpu.error?.code, 'COMPUTE_INPUT_INVALID');

  const tooLong = await provider.execute(action({ language: 'python', code: 'print(1)', timeoutMs: 999_999 }));
  assert.equal(tooLong.ok, false);
  assert.equal(tooLong.error?.code, 'COMPUTE_INPUT_INVALID');
});
