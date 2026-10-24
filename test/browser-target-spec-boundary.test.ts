import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeTargetSpec } from '../src/capabilities/browser-cdp-page.ts';

test('valid observed reference and semantic selectors preserve their exact target identity', () => {
  assert.deepEqual(normalizeTargetSpec({
    ref: '  observed-ref-27  ', role: 'button', name: 'Place order'
  }), { ref: 'observed-ref-27', css: undefined, text: undefined, role: 'button',
    name: 'Place order', renderedColor: undefined });
});

test('browser target parser never truncates a selector to a different real element', () => {
  for (const [key, length] of [
    ['ref', 129], ['css', 501], ['text', 501],
    ['role', 501], ['name', 501], ['renderedColor', 65]
  ] as const) {
    assert.throws(
      () => normalizeTargetSpec({ [key]: 'x'.repeat(length) }),
      (error: any) => error?.code === 'INVALID_BROWSER_TARGET',
      `${key} must not truncate`
    );
  }
});

test('incorrect field types never vanish into an unintended broader selector', () => {
  for (const invalid of [
    null, 'save', true, [], ['button'],
    { ref: 123, role: 'button', name: 'Save' },
    { css: false, text: 'Save' },
    { name: ' ' }, { name: '\0' }, { css: '' }
  ]) {
    assert.throws(
      () => normalizeTargetSpec(invalid),
      (error: any) => error?.code === 'INVALID_BROWSER_TARGET'
    );
  }
});

test('unexpected selector attributes are rejected rather than ignored', () => {
  for (const invalid of [
    { role: 'button', name: 'Pay', tabId: 'foreign-tab' },
    { role: 'textbox', name: 'Email', shadowRoot: 'bypass' },
    { css: '.submit', targetId: 'fabricated' }
  ]) {
    assert.throws(
      () => normalizeTargetSpec(invalid),
      (error: any) => error?.code === 'INVALID_BROWSER_TARGET'
    );
  }
});

test('missing target retains pre-existing empty-selector semantics for outer action validation', () => {
  assert.deepEqual(normalizeTargetSpec(undefined), {
    ref: undefined, css: undefined, text: undefined,
    role: undefined, name: undefined, renderedColor: undefined
  });
});

test('prototype-inherited selector names are never accepted as defined fields', () => {
  for (const invalid of [
    { role: 'button', toString: 'shadow-selector' },
    { role: 'button', constructor: 'mutated-constructor' },
    JSON.parse('{"role":"button","__proto__":"shadow-selector"}')
  ]) {
    assert.throws(() => normalizeTargetSpec(invalid),
      (error: any) => error?.code === 'INVALID_BROWSER_TARGET');
  }
});
