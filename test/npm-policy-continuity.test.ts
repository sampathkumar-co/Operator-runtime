import assert from 'node:assert/strict';
import test from 'node:test';
import { assertNpmPolicyContinuity } from '../scripts/verify-npm-policy-continuity.mjs';

test('new unpublished package may omit a dual-use declaration', () => {
  assert.equal(assertNpmPolicyContinuity(null, {}), false);
});

test('published non-dual-use history does not force a declaration', () => {
  const packument = { versions: { '1.0.0': { name: '@mecrod/operator' } } };
  assert.equal(assertNpmPolicyContinuity(packument, {}), false);
});

test('any historical dual-use version must preserve the declaration', () => {
  const packument = {
    'dist-tags': { latest: '1.0.0' },
    versions: {
      '1.0.0': { name: '@mecrod/operator' },
      '1.1.0-beta.1': { contentPolicy: { class: 'dual-use' } }
    }
  };
  assert.equal(assertNpmPolicyContinuity(packument, { contentPolicy: { class: 'dual-use' } }), true);
  assert.throws(
    () => assertNpmPolicyContinuity(packument, {}),
    /published version history and must persist/
  );
});

test('unsupported contentPolicy values fail closed', () => {
  assert.throws(
    () => assertNpmPolicyContinuity(null, { contentPolicy: { class: 'not-dual-use' } }),
    /Unsupported npm contentPolicy\.class/
  );
});
