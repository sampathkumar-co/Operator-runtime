import assert from 'node:assert/strict';
import test from 'node:test';
import { validatePrEvidence } from '../scripts/verify-pr-evidence.mjs';

const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
function body() {
  return `## Source
Head SHA: ${head}
Baseline SHA: ${base}
Affected source and exact diff.

## Risk
Classification: read. No authority expansion.

## Tests
CI: PENDING, exact-head run not completed.

## Performance
NOT_MEASURED because metadata-only change.

## Rollback
Revert this focused PR and retain prior main.

## Physical acceptance
NOT_RUN on the original Windows device.

## User outcome
NOT_RUN; no real task completed by this source-only PR.
`;
}
const valid = () => ({ number: 404, headSha: head, body: body() });

test('new PR with complete fields is accepted as a declaration, not an independently certified outcome', () => {
  const result = validatePrEvidence(valid());
  assert.equal(result.status, 'SOURCE_EVIDENCE_DECLARED');
  assert.equal(result.baselineSha, base);
  assert.match(result.limitation, /self-reported/);
});

test('legacy historical PR remains grandfathered without claiming certification', () => {
  const result = validatePrEvidence({ number: 403, headSha: head, body: null });
  assert.equal(result.status, 'GRANDFATHERED');
});

test('current HEAD mismatch cannot reuse old PR CI evidence', () => {
  assert.throws(
    () => validatePrEvidence({ ...valid(), headSha: 'c'.repeat(40) }),
    /current exact Head SHA/
  );
});

test('missing, placeholder or duplicate section fails closed', () => {
  assert.throws(() => validatePrEvidence({ ...valid(), body: body().replace('## Rollback', '## Backout') }), /missing ## Rollback/);
  assert.throws(() => validatePrEvidence({ ...valid(), body: body().replace('Revert this focused PR and retain prior main.', 'TODO') }), /lacks evidence/);
  assert.throws(() => validatePrEvidence({ ...valid(), body: body() + '\n## Risk\nduplicate\n' }), /duplicate evidence section/);
});

test('risk, performance and physical acceptance require truthful explicit fields', () => {
  assert.throws(() => validatePrEvidence({ ...valid(),
    body: body().replace('Classification: read. No authority expansion.', 'Unspecified authority condition.')
  }), /Risk classification/);
  assert.throws(() => validatePrEvidence({ ...valid(),
    body: body().replace('NOT_MEASURED because metadata-only change.', 'Latency expected to improve.')
  }), /Performance must state/);
  assert.throws(() => validatePrEvidence({ ...valid(),
    body: body().replace('NOT_RUN on the original Windows device.', 'Windows physically confirmed without evidence.')
  }), /Physical acceptance requires/);
});

test('test results must not be declared SUCCESS without a run link', () => {
  assert.throws(() => validatePrEvidence({ ...valid(),
    body: body().replace('CI: PENDING, exact-head run not completed.', 'CI: SUCCESS')
  }), /Tests must cite/);
});

test('model and browser evaluation limitations can be recorded without fake pass', () => {
  const result = validatePrEvidence({ ...valid(), body: body().replace(
    'NOT_RUN; no real task completed by this source-only PR.',
    'DEFERRED until independently scored real workflows and owner-device checks.'
  ) });
  assert.equal(result.status, 'SOURCE_EVIDENCE_DECLARED');
});
