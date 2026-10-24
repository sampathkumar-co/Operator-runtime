import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeObservationOptions } from '../src/capabilities/browser-cdp-page.ts';

test('legitimate numeric browser observation budgets preserve explicit values', () => {
  const observation = normalizeObservationOptions({
    controlOffset: 3, textOffset: 4, visualOffset: 5,
    maxControls: 40, maxText: 75, maxVisuals: 30, maxBytes: 32_768,
    focusRegion: { x: -15, y: 5, width: 300, height: 120 },
    focusRef: '  control-12  ', focusText: ' Submit '
  });
  assert.equal(observation.controlOffset, 3);
  assert.equal(observation.maxControls, 40);
  assert.deepEqual(observation.focusRegion, { x: -15, y: 5, width: 300, height: 120 });
  assert.equal(observation.focusRef, 'control-12');
  assert.equal(observation.focusText, 'Submit');
});

test('browser observation refuses string, boolean and null budget coercion', () => {
  for (const [key, value] of [
    ['controlOffset', '1'], ['textOffset', null], ['maxControls', true],
    ['visualOffset', false], ['maxBytes', '65536'], ['maxText', 1.5]
  ] as const) {
    assert.throws(
      () => normalizeObservationOptions({ [key]: value }),
      (error: any) => error?.code === 'BROWSER_OBSERVATION_BUDGET_INVALID',
      `${key}=${String(value)} should be refused`
    );
  }
});

test('invalid focus region is never silently dropped or coerced', () => {
  for (const region of [
    '0,0,30,40', null, true, [], [0, 0, 30, 40],
    { x: '0', y: 0, width: 30, height: 40 },
    { x: false, y: 0, width: 30, height: 40 },
    { x: 0, y: 0, width: '30', height: 40 },
    { x: 0, y: 0, width: 30, height: Number.NaN },
    { x: 0, y: 0, width: 0, height: 40 }
  ]) {
    assert.throws(
      () => normalizeObservationOptions({ focusRegion: region }),
      (error: any) => error?.code === 'BROWSER_OBSERVATION_FOCUS_INVALID',
      `Malformed region ${String(region)} should be refused`
    );
  }
});

test('oversized focus selectors are rejected instead of silently changing target identity', () => {
  for (const [key, size] of [
    ['focusRef', 129], ['focusGroupRef', 129], ['focusRole', 101], ['focusText', 501]
  ] as const) {
    assert.throws(
      () => normalizeObservationOptions({ [key]: 'x'.repeat(size) }),
      (error: any) => error?.code === 'BROWSER_OBSERVATION_FOCUS_INVALID'
    );
  }
});

test('default browser observation parameters remain compatible', () => {
  const output = normalizeObservationOptions({});
  assert.equal(output.controlOffset, 0);
  assert.equal(output.maxControls, 120);
  assert.equal(output.maxBytes, 65_536);
  assert.equal(output.focusRegion, undefined);
});
