import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { PUBLIC_PLUGIN_TOOL_NAMES as PUBLIC_TOOL_NAMES } from '../src/core/public-plugin-surface.ts';

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
  assert.equal(manifest.author.name, 'Kinthala Samuel Sampath Kumar');
  assert.equal(manifest.name, 'mecord-connect');
  assert.equal(ui.displayName, 'Mecord Connect');
  assert.equal(ui.developerName, 'Kinthala Samuel Sampath Kumar');
  assert.equal(ui.category, 'Developer Tools');
  assert.ok(ui.capabilities.length <= 20);
  for (const capability of ui.capabilities) assert.ok(capability.length > 0 && capability.length <= 120 && !/[\r\n]/.test(capability));
});

test('directory branding assets satisfy current image constraints', async () => {
  const manifest = await json('.codex-plugin/plugin.json');
  const ui = manifest.interface;

  for (const key of ['logo', 'composerIcon']) {
    const relative = String(ui[key] ?? '');
    assert.ok(relative.length > 0, `${key} is required`);
    assert.equal(relative, './assets/mecord-connect.svg');
    assert.match(relative, /\.(?:png|jpe?g|webp|svg)$/i);

    const file = path.resolve(root, '.codex-plugin', relative);
    const stat = await fs.stat(file);
    assert.ok(stat.isFile());
    assert.ok(stat.size > 0 && stat.size <= 5 * 1024 * 1024);

    if (/\.svg$/i.test(relative)) {
      const svg = await fs.readFile(file, 'utf8');
      assert.match(svg, /^\s*<svg\b/i);
      const viewBox = svg.match(/\bviewBox=["']\s*([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s*["']/i);
      assert.ok(viewBox, `${key} SVG must declare a numeric viewBox`);
      const width = Number(viewBox[3]);
      const height = Number(viewBox[4]);
      assert.ok(Number.isFinite(width) && Number.isFinite(height));
      assert.equal(width, height);
      assert.ok(width >= 48 && width <= 4096);
    }
  }
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

test('current reviewer-facing docs match the canonical nine-tool public surface', async () => {
  const currentDocs = [
    'docs/OPERATOR_DEMO_RECORDING_RUNBOOK.md',
    'docs/OPERATOR_MASTER_GATE_STATUS.md',
    'docs/OPERATOR_OPENAI_PORTAL_ENTRY_PACKET.md',
    'docs/OPERATOR_OPENAI_RELEASE_CERTIFICATION_2026-09.md',
    'docs/OPERATOR_OWNER_RELEASE_DECISION_PACKET.md',
    'docs/OPERATOR_RELEASE_GATE.md',
    'docs/SUBMISSION_PACKAGE.md'
  ];
  for (const relative of currentDocs) {
    const content = await fs.readFile(path.join(root, relative), 'utf8');
    assert.equal(content.includes('`device.claim`'), false, `${relative} still advertises removed public device.claim`);
    assert.doesNotMatch(content, /\b(?:10[- ]tool|ten tools|ten-tool)\b/i, `${relative} still advertises the obsolete ten-tool surface`);
  }

  const review = await json('docs/plugin-review-package.json');
  assert.equal(review.sourceSuccessor.pullRequest, 28);
  assert.equal(review.sourceSuccessor.branch, 'hardening/post-merge-completion');
  assert.equal(review.sourceSuccessor.sourceCommit, 'DYNAMIC_CURRENT_PR_HEAD');
  assert.equal(review.sourceSuccessor.status, 'REQUIRES_EXACT_HEAD_GREEN_BEFORE_MERGE');
});
