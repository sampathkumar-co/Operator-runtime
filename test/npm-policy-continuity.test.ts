import assert from 'node:assert/strict';
import test from 'node:test';
import { assertNpmPolicyContinuity } from '../scripts/verify-npm-policy-continuity.mjs';

test('new unpublished package may omit a dual-use declaration', () => {
  assert.equal(assertNpmPolicyContinuity(null, {}), false);
});

test('non-dual-use published history does not force a declaration', () => {
  const packument = { versions: { '1.0.0': { name: '@mecrod/operator' } } };
  assert.equal(assertNpmPolicyContinuity(packument, {}), false);
});

test('previously dual-use package must preserve the declaration', () => {
  const packument = { versions: { '1.0.0': { contentPolicy: { class: 'dual-use' } } } };
  assert.equal(assertNpmPolicyContinuity(packument, { contentPolicy: { class: 'dual-use' } }), true);
  assert.throws(
    () => assertNpmPolicyContinuity(packument, {}),
    /dual-use declaration was present/
  );
});

test('unsupported contentPolicy values fail closed', () => {
  assert.throws(
    () => assertNpmPolicyContinuity(null, { contentPolicy: { class: 'not-dual-use' } }),
    /Unsupported npm contentPolicy\.class/
  );
});
