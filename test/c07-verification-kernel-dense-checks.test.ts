import assert from 'node:assert/strict';
import test from 'node:test';
import { VerificationKernel } from '../src/core/verification-kernel.ts';

const base = () => ({
  subjectKind: 'task', subjectId: 'task-verified',
  contract: { goal: 'verify actual remote state', actionId: 'action-one' },
  checks: [{ name: 'independent-state', ok: true, detail: 'Fresh state probe succeeded',
    evidenceDigests: ['A'.repeat(64)] }]
});

test('C07 fully specified independent verification remains deterministic', () => {
  const receipt = new VerificationKernel().verify(base());
  assert.equal(receipt.verified, true);
  assert.equal(receipt.checks.length, 1);
  assert.deepEqual(receipt.checks[0]!.evidenceDigests, ['a'.repeat(64)]);
});

test('C07 sparse check arrays cannot create verified receipts by skipping all checks', () => {
  const kernel = new VerificationKernel();
  for (const checks of [
    new Array(1), [, base().checks[0]],
    Object.assign([...base().checks], { hiddenExtra: true }),
    Object.defineProperty([...base().checks], 'unknown', { value: 99 }),
    Object.defineProperty([...base().checks], '0', {
      enumerable: true, get() { throw Error('forged check getter executed'); }
    })
  ]) {
    assert.throws(() => kernel.verify({ ...base(), checks: checks as any }),
      (error: any) => error?.code === 'VERIFICATION_INPUT_INVALID');
  }
});

test('C07 executable or foreign check properties never produce proof', () => {
  const kernel = new VerificationKernel();
  let callbacks = 0;
  const seed = base().checks[0]!;
  const hostile = [
    Object.defineProperty({ ...seed }, 'ok', {
      enumerable: true, get() { callbacks++; return true; }
    }),
    Object.defineProperty({ ...seed }, 'evidenceDigests', {
      enumerable: true, get() { callbacks++; return ['a'.repeat(64)]; }
    }),
    Object.assign(Object.create({ principal: 'trusted' }), seed),
    Object.assign({ ...seed }, { declaredAuthority: 'write' }),
    Object.defineProperty({ ...seed }, Symbol('hidden'), { value: 'scoped-proof' })
  ];
  for (const check of hostile) {
    assert.throws(() => kernel.verify({ ...base(), checks: [check] as any }),
      (error: any) => error?.code === 'VERIFICATION_INPUT_INVALID');
  }
  assert.equal(callbacks, 0);
});

test('C07 evidence digests must be literal dense arrays without executable slots', () => {
  const kernel = new VerificationKernel();
  let getterCalls = 0;
  const forged = Object.defineProperty(['a'.repeat(64)], '0', {
    enumerable: true, get() { getterCalls++; return 'a'.repeat(64); }
  });
  for (const digests of [
    new Array(1), forged, Object.assign(['a'.repeat(64)], { role: 'approved' }),
    [{ toString() { getterCalls++; return 'a'.repeat(64); } }]
  ]) {
    assert.throws(() => kernel.verify({
      ...base(), checks: [{ ...base().checks[0], evidenceDigests: digests as any }]
    }), (error: any) => error?.code === 'VERIFICATION_INPUT_INVALID');
  }
  assert.equal(getterCalls, 0);
});
