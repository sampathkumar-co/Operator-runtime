import assert from 'node:assert/strict';
import test from 'node:test';
import { createEvidencePack } from '../src/core/evidence-pack.ts';

const hash = 'a'.repeat(64);
const base = () => ({
  executionContext: { schemaVersion: 1 as const, taskId: 'bounded-c07-claim' },
  artifactIds: [hash],
  claims: [{ id: 'machine-proof', statement: 'Exact scoped file content matches.',
    level: 'PROVEN' as const, artifactIds: [hash], verifier: 'trusted-read-probe' }],
  residualUncertainty: ['Original host still requires acceptance']
});

test('C07 inert claim normalization keeps ordinary source-bound evidence unchanged', () => {
  const pack = createEvidencePack(base());
  assert.equal(pack.claims.length, 1);
  assert.equal(pack.claims[0]!.id, 'machine-proof');
  assert.equal(pack.claims[0]!.level, 'PROVEN');
  assert.deepEqual(pack.residualUncertainty, ['Original host still requires acceptance']);
});

test('C07 sparse or hidden claim list cannot be interpreted as an empty verified result', () => {
  for (const claims of [
    new Array(1), [undefined],
    Object.assign([base().claims[0]], { extra: true }),
    Object.defineProperty([base().claims[0]], 'secret', { value: 'scope-override' }),
    Object.defineProperty([base().claims[0]], '0', { get: () => { throw Error('getter executed'); }, enumerable: true })
  ]) {
    assert.throws(() => createEvidencePack({ ...base(), claims: claims as any }),
      (e: any) => e?.code === 'EVIDENCE_PACK_INVALID');
  }
});

test('C07 executable, inherited, nonenumerable or foreign fields cannot forge a claim', () => {
  let invoked = 0;
  const regular = base().claims[0]!;
  const adversarial = [
    Object.defineProperty({ ...regular }, 'level', { enumerable: true, get() {
      invoked++; return 'PROVEN';
    } }),
    Object.defineProperty({ ...regular }, 'artifactIds', { enumerable: false, value: [hash] }),
    { ...regular, extraAuthority: 'approved' },
    Object.assign(Object.create({ role: 'authorized' }), regular),
    JSON.parse(JSON.stringify({ ...regular, '__proto__not_a_claim_key': 'injected' }))
  ];
  for (const claim of adversarial) {
    assert.throws(() => createEvidencePack({ ...base(), claims: [claim] as any }),
      (e: any) => e?.code === 'EVIDENCE_PACK_INVALID');
  }
  assert.equal(invoked, 0);
});

test('C07 proof hash arrays and uncertainty text require exact dense inert slots', () => {
  let invoked = 0;
  const malformedDigest = Object.defineProperty([hash], '0', {
    enumerable: true, get() { invoked++; return hash; }
  });
  const malformedText = Object.defineProperty(['unresolved'], '0', {
    enumerable: true, get() { invoked++; return 'unresolved'; }
  });
  const all = [
    { ...base(), artifactIds: malformedDigest },
    { ...base(), claims: [{ ...base().claims[0], artifactIds: malformedDigest }] },
    { ...base(), residualUncertainty: new Array(1) },
    { ...base(), residualUncertainty: malformedText },
    { ...base(), residualUncertainty: Object.assign(['uncertain'], { extra: true }) }
  ];
  for (const input of all) {
    assert.throws(() => createEvidencePack(input as any),
      (e: any) => e?.code === 'EVIDENCE_PACK_INVALID');
  }
  assert.equal(invoked, 0);
});
