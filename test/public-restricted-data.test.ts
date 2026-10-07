import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertNoRestrictedData,
  containsRestrictedData
} from '../src/core/public-restricted-data.ts';

const blocked = [
  'password=hunter2',
  'api_key=abcdefghijklmnopqrstuvwxyz',
  'AWS_SECRET_ACCESS_KEY=abcdEFGHijklMNOPqrstUVWXyz0123456789ABCD',
  'DATABASE_URL=postgres://alice:supersecret@db.example/app',
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlMTIzNDU2Nzg5MA',
  ['xoxb', '1234567890', 'abcdefghijklmnopqrstuvwxyz'].join('-'),
  'glpat-abcdefghijklmnopqrstuvwxyz',
  'AIzaSyDUMMYKEY01234567890123456789012',
  ['sk', 'live', '1234567890abcdefghijklmnopqrstuv'].join('_'),
  '//registry.npmjs.org/:_authToken=abcdefghijklmnopqrstuvwxyz',
  'DefaultEndpointsProtocol=https;AccountName=test;AccountKey=YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo=;',
  'Authorization: Bearer abcdefghijklmnopqrstuvwxyz',
  'verification code=123456',
  '-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----'
];
test('restricted-data fuzz corpus is blocked recursively', () => {
  for (const sample of blocked) {
    assert.equal(containsRestrictedData(sample), true, sample);
    assert.throws(() => assertNoRestrictedData({ nested: [{ value: sample }] }), {
      name: 'OperatorError'
    });
  }
});

test('sensitive object keys are blocked when populated', () => {
  const samples = [
    { password: 'hunter2' },
    { apiKey: 'abcdefghijklmnopqrstuvwxyz' },
    { client_secret: 'abcdefghijklmnopqrstuvwxyz' },
    { refreshToken: 'abcdefghijklmnopqrstuvwxyz' },
    { sessionId: 'abcdefghijklmnopqrstuvwxyz' }
  ];
  for (const sample of samples) assert.equal(containsRestrictedData(sample), true);
});

test('ordinary source-code words do not become false positives', () => {
  const safe = [
    'const passwordField = form.password;',
    'function refreshTokenCache() { return false; }',
    'diagnosisCode is a schema field name',
    'API_KEY_NAME is documented but no value is supplied'
  ];
  for (const sample of safe) assert.equal(containsRestrictedData(sample), false, sample);
});


test('payment-card detection requires plausible issuer identity and does not flag numeric runtime metadata', () => {
  const safeRuntimeResult = {
    output: {
      identity: {
        device: '2049',
        inode: '1760000000000000008',
        links: '1',
        size: 14,
        modifiedNs: '1760000000000000008',
        changedNs: '1760000000000000008',
        createdNs: '1760000000000000008',
        digest: 'a'.repeat(64)
      },
      sha256: 'c4ea45b2615142bda2e48e57043ed6e5ebe3e980b4158f786c6b009ead0b2707',
      content: 'after rotation'
    }
  };
  assert.equal(containsRestrictedData(safeRuntimeResult), false);
});

test('known payment-network card numbers remain restricted', () => {
  for (const value of [
    '4111111111111111',
    '5555555555554444',
    '378282246310005',
    '6011111111111117'
  ]) assert.equal(containsRestrictedData(value), true, value);
});
