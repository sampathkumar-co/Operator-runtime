import assert from 'node:assert/strict';
import test from 'node:test';
import { validateProductionReleaseInputs } from '../scripts/production-release-inputs.mjs';

const valid = {
  version: '0.1.0.0',
  identityName: 'Operator.Runtime',
  updateBaseUri: 'https://downloads.operatorruntime.dev/product',
  timestampUri: 'https://timestamp.digicert.com'
};

test('production release inputs accept a real HTTPS release host and timestamp service', () => {
  const parsed = validateProductionReleaseInputs(valid);
  assert.equal(parsed.version, '0.1.0.0');
  assert.equal(parsed.updateBaseUri, 'https://downloads.operatorruntime.dev/product');
});

test('production update base rejects malformed append semantics and placeholder hosts', () => {
  assert.throws(() => validateProductionReleaseInputs({ ...valid, updateBaseUri: 'https://downloads.operatorruntime.dev/product?channel=stable' }), /query string/);
  assert.throws(() => validateProductionReleaseInputs({ ...valid, updateBaseUri: 'https://downloads.operatorruntime.dev/product#latest' }), /fragment/);
  assert.throws(() => validateProductionReleaseInputs({ ...valid, updateBaseUri: 'https://updates.example.invalid/operator' }), /real non-loopback/);
  assert.throws(() => validateProductionReleaseInputs({ ...valid, updateBaseUri: 'https://127.0.0.1/operator' }), /real non-loopback/);
});
