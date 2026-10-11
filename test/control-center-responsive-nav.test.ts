import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ui = path.resolve(here, '../apps/control-center/src');
const [css, html] = await Promise.all([
  fs.readFile(path.join(ui, 'styles.css'), 'utf8'),
  fs.readFile(path.join(ui, 'shell.html'), 'utf8')
]);

test('Control Center tab rail is scrollable instead of clipping off-screen sections', () => {
  const tabRail = css.match(/\.tabs\{([^}]+)\}/)?.[1];
  const tab = css.match(/\.tab\{([^}]+)\}/)?.[1];
  assert.ok(tabRail, 'Control Center tab rail CSS must exist');
  assert.ok(tab, 'Control Center tab CSS must exist');
  assert.match(tabRail, /(?:^|;)overflow-x:auto(?:;|$)/,
    'Tab rail must enable horizontal scrolling to make off-screen sections reachable');
  assert.match(tabRail, /(?:^|;)max-width:100%(?:;|$)/,
    'Tab rail must remain bounded by the containing panel width');
  assert.match(tab, /(?:^|;)flex:0 0 auto(?:;|$)/,
    'Tab buttons must retain their readable width inside a scrollable tab rail');
});

test('All Control Center tab buttons target present panel IDs with exactly one initial selection', () => {
  assert.match(html, /role="tablist"[^>]*aria-label="Control Center sections"/);
  const tabs = [...html.matchAll(/<button\b[^>]*role="tab"[^>]*data-tab="([^"]+)"[^>]*>/g)];
  assert.ok(tabs.length >= 10, 'Expected the complete Control Center tab navigation');
  assert.equal(new Set(tabs.map(t => t[1])).size, tabs.length, 'Tab keys must be unique');
  assert.equal(tabs.filter(t => t[0].includes('aria-selected="true"')).length, 1,
    'Only one tab can start selected');
  for (const [, id] of tabs) {
    assert.ok(html.includes('id="' + id + '"'), 'Missing panel for tab ' + id);
  }
});
