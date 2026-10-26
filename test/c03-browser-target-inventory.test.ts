import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeCdpTargets } from '../src/capabilities/browser-cdp.ts';
import { requirePageTarget, requireTarget } from '../src/capabilities/browser-cdp-page.ts';

const page = (id: string) => ({
  id, type: 'page', title: 'Fixture', url: 'https://example.test/',
  webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/' + id
});

test('C03 valid bounded browser discovery preserves exact tab identities', () => {
  const targets = normalizeCdpTargets([page('A1'), page('B2')]);
  assert.deepEqual(targets.map(x => x.id), ['A1', 'B2']);
  assert.equal(requireTarget(targets, 'B2').id, 'B2');
  assert.throws(() => requirePageTarget(targets),
    (error: any) => error?.code === 'BROWSER_TARGET_AMBIGUOUS');
});

test('C03 malformed/coerced CDP target identifiers are never normalized into authority', () => {
  let conversions = 0;
  const hostile = { toString() { conversions++; return 'A1'; } };
  for (const invalid of [
    null, {}, [{ id: hostile, type: 'page' }],
    [{ ...page('A1'), id: ['A1'] }],
    [{ ...page('A1'), id: '' }],
    [{ ...page('A1'), id: 'A1 A2' }],
    [page('A1'), page('A1')],
    [{ ...page('A1'), title: ['Fixture'] }],
    [{ ...page('A1'), url: { href: 'https://example.test/' } }],
    [{ ...page('A1'), title: 'title' + String.fromCharCode(0) }]
  ]) {
    assert.throws(() => normalizeCdpTargets(invalid),
      (error: any) => ['CDP_DISCOVERY_INVALID','CDP_DISCOVERY_INCOMPLETE'].includes(error?.code));
  }
  assert.equal(conversions, 0);
});

test('C03 truncated page inventory cannot pretend to establish unique implicit navigation target', () => {
  const large = Array.from({ length: 101 }, (_, i) => page('tab-' + i));
  assert.throws(() => normalizeCdpTargets(large), (error: any) =>
    error?.code === 'CDP_DISCOVERY_INCOMPLETE');
  assert.equal(normalizeCdpTargets(large.slice(0, 100)).length, 100);
});
