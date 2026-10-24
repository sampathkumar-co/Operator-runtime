import assert from 'node:assert/strict';
import test from 'node:test';
import { VerificationKernel } from '../src/core/verification-kernel.ts';

const lower = 'abcdef0123456789'.repeat(4);
const upper = lower.toUpperCase();
const kernel = new VerificationKernel();
function receipt(evidenceDigests: string[]) {
  return kernel.verify({
    subjectKind: 'task', subjectId: 'synthetic-proof',
    contract: { goal: 'verify independently supplied artifact' },
    checks: [{ name: 'artifact-sha', ok: true, detail: 'synthetic fixture', evidenceDigests }]
  });
}

test('equivalent hexadecimal proof spellings cannot create duplicate receipt identities', () => {
  const one = receipt([lower]);
  const repeated = receipt([upper, lower, upper]);
  assert.equal(one.digest, repeated.digest);
  assert.deepEqual(one.checks[0]?.evidenceDigests, [lower]);
  assert.deepEqual(repeated.checks[0]?.evidenceDigests, [lower]);
});

test('proof input is bounded before deduplication to stop large repeated claims', () => {
  assert.throws(
    () => receipt(Array.from({ length: 1001 }, () => lower)),
    (error: any) => error?.code === 'VERIFICATION_INPUT_INVALID'
  );
});

test('malformed evidence arrays and identifiers fail closed', () => {
  for (const invalid of [42, 'abc', { length: 2 }, [lower, null]]) {
    assert.throws(
      () => receipt(invalid as string[]),
      (error: any) => error?.code === 'VERIFICATION_INPUT_INVALID'
    );
  }
});

test('verification receipt remains order-independent with canonicalized proof IDs', () => {
  const second = 'b'.repeat(64);
  const a = receipt([second, upper]);
  const b = receipt([lower, second]);
  assert.equal(a.digest, b.digest);
  assert.deepEqual(a.checks[0]?.evidenceDigests, [second, lower].sort());
});

test('a failed check is not promoted by the presence of a valid digest', () => {
  const failed = kernel.verify({
    subjectKind: 'task', subjectId: 'synthetic-proof',
    contract: { goal: 'verify independently supplied artifact' },
    checks: [{ name: 'artifact-sha', ok: false, detail: 'artifact mismatch', evidenceDigests: [lower] }]
  });
  assert.equal(failed.verified, false);
});
