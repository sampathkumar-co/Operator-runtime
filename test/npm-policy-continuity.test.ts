import assert from 'node:assert/strict';
import test from 'node:test';
import { assertNpmPolicyContinuity } from '../scripts/verify-npm-policy-continuity.mjs';

const candidate = {
  name: 'mecord-connect',
  contentPolicy: { class: 'dual-use' }
};

test('new unpublished Mecord Connect package requires dual-use declaration', () => {
  assert.equal(assertNpmPolicyContinuity(null, candidate), false);
  assert.throws(
    () => assertNpmPolicyContinuity(null, { name: 'mecord-connect' }),
    /must declare npm contentPolicy\.class as dual-use/
  );
});

test('published non-dual-use history is accepted when the new candidate declares dual-use', () => {
  const packument = { name: 'mecord-connect', versions: { '1.0.0': { name: 'mecord-connect' } } };
  assert.equal(assertNpmPolicyContinuity(packument, candidate), false);
});

test('any historical dual-use version is detected and the declaration remains present', () => {
  const packument = {
    name: 'mecord-connect',
    'dist-tags': { latest: '1.0.0' },
    versions: {
      '1.0.0': { name: 'mecord-connect' },
      '1.1.0-beta.1': { contentPolicy: { class: 'dual-use' } }
    }
  };
  assert.equal(assertNpmPolicyContinuity(packument, candidate), true);
});

test('unsupported or missing candidate contentPolicy values fail closed', () => {
  assert.throws(
    () => assertNpmPolicyContinuity(null, { name: 'mecord-connect', contentPolicy: { class: 'not-dual-use' } }),
    /must declare npm contentPolicy\.class as dual-use/
  );
  assert.throws(
    () => assertNpmPolicyContinuity(null, { name: 'mecord-connect' }),
    /must declare npm contentPolicy\.class as dual-use/
  );
});

test('malformed or mismatched registry metadata fails closed', () => {
  assert.throws(
    () => assertNpmPolicyContinuity({ name: 'mecord-connect' }, candidate),
    /missing the versions map/
  );
  assert.throws(
    () => assertNpmPolicyContinuity({ name: '@other/package', versions: {} }, candidate),
    /package name mismatch/
  );
});

test('unsupported historical contentPolicy classes fail closed', () => {
  const packument = {
    name: 'mecord-connect',
    versions: { '1.0.0': { contentPolicy: { class: 'future-policy-class' } } }
  };
  assert.throws(
    () => assertNpmPolicyContinuity(packument, candidate),
    /unsupported published contentPolicy class/
  );
});
