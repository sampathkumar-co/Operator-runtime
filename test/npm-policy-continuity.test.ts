import assert from 'node:assert/strict';
import test from 'node:test';
import { assertNpmPolicyContinuity } from '../scripts/verify-npm-policy-continuity.mjs';

test('new unpublished package may omit a dual-use declaration', () => {
  assert.equal(assertNpmPolicyContinuity(null, { name: '@mecrod/operator' }), false);
});

test('published non-dual-use history does not force a declaration', () => {
  const packument = { name: '@mecrod/operator', versions: { '1.0.0': { name: '@mecrod/operator' } } };
  assert.equal(assertNpmPolicyContinuity(packument, { name: '@mecrod/operator' }), false);
});

test('any historical dual-use version must preserve the declaration', () => {
  const packument = {
    name: '@mecrod/operator',
    'dist-tags': { latest: '1.0.0' },
    versions: {
      '1.0.0': { name: '@mecrod/operator' },
      '1.1.0-beta.1': { contentPolicy: { class: 'dual-use' } }
    }
  };
  assert.equal(assertNpmPolicyContinuity(packument, { name: '@mecrod/operator', contentPolicy: { class: 'dual-use' } }), true);
  assert.throws(
    () => assertNpmPolicyContinuity(packument, { name: '@mecrod/operator' }),
    /published version history and must persist/
  );
});

test('unsupported contentPolicy values fail closed', () => {
  assert.throws(
    () => assertNpmPolicyContinuity(null, { name: '@mecrod/operator', contentPolicy: { class: 'not-dual-use' } }),
    /Unsupported npm contentPolicy\.class/
  );
});

test('malformed or mismatched registry metadata fails closed', () => {
  assert.throws(
    () => assertNpmPolicyContinuity({ name: '@mecrod/operator' }, { name: '@mecrod/operator' }),
    /missing the versions map/
  );
  assert.throws(
    () => assertNpmPolicyContinuity({ name: '@other/package', versions: {} }, { name: '@mecrod/operator' }),
    /package name mismatch/
  );
});

test('unsupported historical contentPolicy classes fail closed', () => {
  const packument = {
    name: '@mecrod/operator',
    versions: { '1.0.0': { contentPolicy: { class: 'future-policy-class' } } }
  };
  assert.throws(
    () => assertNpmPolicyContinuity(packument, { name: '@mecrod/operator' }),
    /unsupported published contentPolicy class/
  );
});
