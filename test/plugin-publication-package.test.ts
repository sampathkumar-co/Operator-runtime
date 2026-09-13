import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { PUBLIC_TOOL_NAMES } from '../apps/mcp-server/src/public-tools.ts';

const root = path.resolve(import.meta.dirname, '..');

async function json(relative: string): Promise<any> {
  return JSON.parse(await fs.readFile(path.join(root, relative), 'utf8'));
}

test('public plugin manifest satisfies final directory field limits', async () => {
  const manifest = await json('.codex-plugin/plugin.json');
  const ui = manifest.interface;
  assert.match(manifest.name, /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
  assert.match(manifest.version, /^\d+\.\d+\.\d+/);
  assert.ok(ui.displayName.length <= 30);
  assert.ok(ui.shortDescription.length <= 30);
  assert.ok(ui.longDescription.length <= 4000);
  assert.ok(ui.developerName.length <= 80);
  assert.equal(manifest.author.name, ui.developerName);
  assert.equal(ui.category, 'Developer Tools');
  assert.ok(ui.capabilities.length <= 20);
  for (const capability of ui.capabilities) assert.ok(capability.length > 0 && capability.length <= 120 && !/[\r\n]/.test(capability));
});

test('MCP-backed listing URLs and starter prompts are submission-safe', async () => {
  const manifest = await json('.codex-plugin/plugin.json');
  const ui = manifest.interface;
  for (const key of ['websiteURL', 'privacyPolicyURL', 'termsOfServiceURL', 'supportURL']) {
    const value = String(ui[key] ?? '');
    const parsed = new URL(value);
    assert.equal(parsed.protocol, 'https:');
    assert.ok(value.length <= 1024);
    assert.equal(parsed.username, '');
    assert.equal(parsed.password, '');
  }
  assert.ok(Array.isArray(ui.defaultPrompt));
  assert.ok(ui.defaultPrompt.length > 0 && ui.defaultPrompt.length <= 3);
  const normalized = ui.defaultPrompt.map((value: string) => value.normalize('NFKC').replace(/\s+/g, ' ').trim());
  assert.equal(new Set(normalized).size, normalized.length);
  for (const prompt of normalized) {
    assert.ok(prompt.length <= 128);
    assert.equal(prompt.includes('@'), false);
    assert.equal(/[\r\n]/.test(prompt), false);
  }
});

test('review package has exact cases and complete public-tool annotation justifications', async () => {
  const review = await json('docs/plugin-review-package.json');
  assert.equal(review.positiveTests.length, 5);
  assert.equal(review.negativeTests.length, 3);
  const ids = [...review.positiveTests, ...review.negativeTests].map((entry: any) => entry.id);
  assert.equal(new Set(ids).size, 8);

  const justified = Object.keys(review.toolJustifications).sort();
  assert.deepEqual(justified, [...PUBLIC_TOOL_NAMES].sort());
  for (const tool of PUBLIC_TOOL_NAMES) {
    const item = review.toolJustifications[tool];
    for (const key of ['readOnlyHint', 'openWorldHint', 'destructiveHint']) {
      assert.equal(typeof item[key], 'string');
      assert.ok(item[key].length >= 20);
    }
  }
  for (const forbidden of ['terminal.execute', 'browser.interact', 'app.operate', 'postgres.query']) {
    assert.equal(PUBLIC_TOOL_NAMES.includes(forbidden), false);
  }
});
