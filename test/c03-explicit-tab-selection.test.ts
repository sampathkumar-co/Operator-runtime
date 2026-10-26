import assert from 'node:assert/strict';
import test from 'node:test';
import { requirePageTarget, requireTarget } from '../src/capabilities/browser-cdp-page.ts';
import type { CdpTarget } from '../src/capabilities/browser-cdp-connection.ts';

const page = (id: string): CdpTarget => ({
  id, type: 'page', title: 'Fixture', url: 'https://example.test/' + id
});

test('C03 browser navigation defaults only when exactly one page exists', () => {
  const onlyPage = page('page-1');
  assert.equal(requirePageTarget([{ id: 'worker', type: 'service_worker' }, onlyPage]).id, 'page-1');
  assert.throws(() => requirePageTarget([{ id: 'worker', type: 'service_worker' }]),
    (error: any) => error?.code === 'BROWSER_TARGET_NOT_FOUND');
});

test('C03 browser default target refuses ambiguous pages before any CDP command', () => {
  const tabs = [page('page-1'), page('page-2')];
  assert.throws(() => requirePageTarget(tabs), (error: any) =>
    error?.code === 'BROWSER_TARGET_AMBIGUOUS' &&
    error?.details?.remedy === 'select_target_id_from_current_tabs' &&
    error?.details?.executionPhase === 'pre_dispatch' &&
    error?.details?.sideEffectState === 'none');
  assert.equal(requireTarget(tabs, 'page-2').id, 'page-2');
});

test('C03 duplicate discovered target identities cannot silently choose first match', () => {
  const duplicate = [page('duplicate-id'), { ...page('duplicate-id'), url: 'https://different.test/' }];
  assert.throws(() => requireTarget(duplicate, 'duplicate-id'), (error: any) =>
    error?.code === 'BROWSER_TARGET_AMBIGUOUS' &&
    error?.details?.remedy === 'reobserve_before_retry');
  assert.throws(() => requireTarget(duplicate, 'unseen-id'), (error: any) =>
    error?.code === 'BROWSER_TARGET_NOT_FOUND');
});
