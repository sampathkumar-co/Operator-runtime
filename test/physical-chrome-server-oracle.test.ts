import assert from 'node:assert/strict';
import test from 'node:test';
import { certifyPhysicalChromeOracle, validServerReceipts } from '../scripts/certify-chrome-server-oracle.mjs';

const expected = Array.from({ length: 5 }, (_, i) => ({
  id: 'case-' + i, value: 'value-' + i, receipt: 'receipt-' + i
}));
const accepted = expected.map(x => ({ ...x, accepted: true }));

test('C01 independent server oracle requires five matching unique accepted records', () => {
  assert.equal(validServerReceipts(expected, accepted), true);
  assert.equal(validServerReceipts(expected, accepted.slice(0, 4)), false);
  assert.equal(validServerReceipts(expected, [...accepted.slice(0, 4), accepted[0]]), false);
  assert.equal(validServerReceipts(expected, accepted.map((x, i) => i === 1
    ? { ...x, receipt: 'forged' } : x)), false);
  assert.equal(validServerReceipts(expected, accepted.map((x, i) => i === 1
    ? { ...x, accepted: false } : x)), false);
  assert.equal(validServerReceipts(expected, [...accepted].reverse()), false);
});
test('C01 physical Chrome campaign refuses implicit Windows opt-in or non-Windows execution', async () => {
  await assert.rejects(certifyPhysicalChromeOracle({
    platform: 'linux', env: { MECORD_PHYSICAL_ACCEPTANCE: '1' }
  }), /PHYSICAL_CHROME_ORACLE_NOT_AUTHORIZED/);
  await assert.rejects(certifyPhysicalChromeOracle({
    platform: 'win32', env: {}
  }), /PHYSICAL_CHROME_ORACLE_NOT_AUTHORIZED/);
});
test('C01 explicit opt-in still requires installed physical Chrome before any task', async () => {
  await assert.rejects(certifyPhysicalChromeOracle({
    platform: 'win32', env: { MECORD_PHYSICAL_ACCEPTANCE: '1' },
    chromePath: 'C:\\this\\chrome\\does-not-exist.exe'
  }), /PHYSICAL_CHROME_ORACLE_NO_CHROME/);
});
