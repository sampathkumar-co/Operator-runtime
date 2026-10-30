import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { PUBLIC_PLUGIN_TOOL_NAMES } from '../src/core/public-plugin-surface.ts';
import { TOOL_NAMES } from '../apps/mcp-server/src/tool-surface.ts';
import { RELEASE_TRUTH } from '../src/core/release-truth.ts';

const source = new URL('../docs/C10_SOURCE_FEATURE_MATRIX_2026-10-24.md', import.meta.url);
test('C10 documented public nine is exactly the independently declared public plugin contract', async () => {
  const doc = await fs.readFile(source, 'utf8');
  const section = doc.split('## Public nine-tool contract')[1]?.split('## Private Developer surface')[0];
  assert.ok(section);
  const rows = [...section.matchAll(/^\| \x60([^\x60]+)\x60 \|/gm)].map(m => m[1]).sort();
  assert.deepEqual(rows, [...PUBLIC_PLUGIN_TOOL_NAMES].sort());
  assert.equal(rows.length, 9);
});
test('C10 private capability examples cannot be mistaken for public scopes or live grants', async () => {
  const doc = await fs.readFile(source, 'utf8');
  const privateSamples = [
    'browser.interact', 'app.operate', 'terminal.execute', 'docker.manage',
    'postgres.query', 'workspace.edit', 'task.submit'
  ];
  for (const name of privateSamples) {
    assert.ok(TOOL_NAMES.includes(name), 'Private source tool absent: ' + name);
    assert.ok(!PUBLIC_PLUGIN_TOOL_NAMES.includes(name), 'Private tool leaked into public contract: ' + name);
  }
  assert.match(doc, /Release candidate acceptance: NOT ACCEPTED/);
  assert.match(doc, /original-device physical acceptance not established/i);
  assert.equal(RELEASE_TRUTH.source.runtimePackageVersion, '2.0.7');
});
