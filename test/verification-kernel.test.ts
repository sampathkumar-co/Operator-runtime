import assert from 'node:assert/strict';
import test from 'node:test';
import { VerificationKernel } from '../src/core/verification-kernel.ts';

test('verification receipts are deterministic across check ordering', () => {
  const kernel = new VerificationKernel();
  const contract = { objective: 'deploy', version: 2 };
  const a = kernel.verify({
    subjectKind: 'operation',
    subjectId: 'op-1',
    contract,
    checks: [
      { name: 'health', ok: true, detail: 'healthy', evidenceDigests: ['a'.repeat(64)] },
      { name: 'version', ok: true, detail: 'version matches', evidenceDigests: ['b'.repeat(64)] }
    ]
  });
  const b = kernel.verify({
    subjectKind: 'operation',
    subjectId: 'op-1',
    contract,
    checks: [
      { name: 'version', ok: true, detail: 'version matches', evidenceDigests: ['b'.repeat(64)] },
      { name: 'health', ok: true, detail: 'healthy', evidenceDigests: ['a'.repeat(64)] }
    ]
  });
  assert.equal(a.digest, b.digest);
  assert.equal(a.verified, true);
});

test('one failed check prevents verified receipt', () => {
  const receipt = new VerificationKernel().verify({
    subjectKind: 'task',
    subjectId: 'task-1',
    contract: { success: ['state healthy'] },
    checks: [
      { name: 'positive-postcondition', ok: true, detail: 'healthy state observed' },
      { name: 'negative-postcondition', ok: false, detail: 'error rate exceeded threshold' }
    ]
  });
  assert.equal(receipt.verified, false);
  assert.match(receipt.digest, /^[0-9a-f]{64}$/);
});

test('duplicate checks and malformed evidence fail closed', () => {
  const kernel = new VerificationKernel();
  assert.throws(() => kernel.verify({
    subjectKind: 'task',
    subjectId: 'task-1',
    contract: {},
    checks: [
      { name: 'same', ok: true, detail: 'a' },
      { name: 'same', ok: true, detail: 'b' }
    ]
  }), (error: any) => error?.code === 'VERIFICATION_INPUT_INVALID');

  assert.throws(() => kernel.verify({
    subjectKind: 'task',
    subjectId: 'task-1',
    contract: {},
    checks: [{ name: 'evidence', ok: true, detail: 'bad digest', evidenceDigests: ['not-a-digest'] }]
  }), (error: any) => error?.code === 'VERIFICATION_INPUT_INVALID');
});
