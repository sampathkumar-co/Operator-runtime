import assert from 'node:assert/strict';
import test from 'node:test';
import { assertNpmPolicyContinuity } from '../scripts/verify-npm-policy-continuity.mjs';

test('new unpublished package may omit a dual-use declaration', () => {
  assert.equal(assertNpmPolicyContinuity(null, {}), false);
});

test('currently published non-dual-use version does not force a declaration', () => {
  const publishedLatest = { name: '@mecrod/operator', version: '1.0.0' };
  assert.equal(assertNpmPolicyContinuity(publishedLatest, {}), false);
});

test('currently published dual-use version must preserve the declaration', () => {
  const publishedLatest = { name: '@mecrod/operator', version: '1.0.0', contentPolicy: { class: 'dual-use' } };
  assert.equal(assertNpmPolicyContinuity(publishedLatest, { contentPolicy: { class: 'dual-use' } }), true);
  assert.throws(
    () => assertNpmPolicyContinuity(publishedLatest, {}),
    /currently published version and must persist/
  );
});

test('unsupported contentPolicy values fail closed', () => {
  assert.throws(
    () => assertNpmPolicyContinuity(null, { contentPolicy: { class: 'not-dual-use' } }),
    /Unsupported npm contentPolicy\.class/
  );
});
