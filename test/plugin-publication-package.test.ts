import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { PUBLIC_PLUGIN_TOOL_NAMES as PUBLIC_TOOL_NAMES } from '../src/core/public-plugin-surface.ts';
import { PRODUCT_VERSION } from '../src/core/product-identity.ts';

const root = path.resolve(import.meta.dirname, '..');

async function json(relative: string): Promise<any> {
  return JSON.parse(await fs.readFile(path.join(root, relative), 'utf8'));
}

test('public plugin manifest satisfies final directory field limits', async () => {
  const manifest = await json('.codex-plugin/plugin.json');
  const releaseState = await json('docs/release-state.json');
  const ui = manifest.interface;
  assert.match(manifest.name, /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
  assert.match(manifest.version, /^\d+\.\d+\.\d+/);
  assert.equal(manifest.version, PRODUCT_VERSION, 'plugin manifest version must match the public MCP product version');
  assert.equal(manifest.version, releaseState.versions.publicProduct);
  const runtimePackage = await json('packages/mecord-connect/package.json');
  assert.match(runtimePackage.version, /^\d+\.\d+\.\d+$/);
  assert.equal(runtimePackage.name, 'mecord-connect');
  assert.equal(runtimePackage.version, releaseState.versions.runtimePackage);
  const publicParts = manifest.version.split('.').map(Number);
  const runtimeParts = runtimePackage.version.split('.').map(Number);
  assert.equal(runtimeParts[0], publicParts[0], 'npm runtime major must remain compatible with the public plugin major');
  assert.equal(runtimeParts[1], publicParts[1], 'runtime patch releases must stay within the public plugin major/minor line');
  assert.ok(runtimeParts[2] >= publicParts[2], 'runtime patch must not be older than the public plugin patch');
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

test('reviewer-facing evidence reflects the deployed canonical nine-tool production surface', async () => {
  const finalSurfaceDocs = [
    'docs/OPERATOR_DEMO_RECORDING_RUNBOOK.md',
    'docs/OPERATOR_OPENAI_PORTAL_ENTRY_PACKET.md',
    'docs/OPERATOR_OWNER_RELEASE_DECISION_PACKET.md',
    'docs/SUBMISSION_PACKAGE.md'
  ];
  for (const relative of finalSurfaceDocs) {
    const content = await fs.readFile(path.join(root, relative), 'utf8');
    assert.doesNotMatch(content, /(?:^|\n)\s*(?:[-*]|\d+\.)\s*`device\.claim`\b/m, `${relative} still lists removed public device.claim as part of the final surface`);
    assert.doesNotMatch(content, /\b(?:10[- ]tool|ten tools|ten-tool)\b/i, `${relative} still advertises the obsolete ten-tool final surface`);
  }

  const releaseState = await json('docs/release-state.json');
  const certification = await fs.readFile(path.join(root, 'docs/OPERATOR_OPENAI_RELEASE_CERTIFICATION_2026-09.md'), 'utf8');
  assert.equal(certification.includes(`source: \`${releaseState.production.sourceCommit}\``), true);
  assert.equal(certification.includes('public surface: exactly 9 MCP tools'), true);
  assert.match(certification, /legacy public `device\.claim`: absent/);

  const releaseGate = await fs.readFile(path.join(root, 'docs/OPERATOR_RELEASE_GATE.md'), 'utf8');
  assert.equal(releaseGate.includes(`Current production source: \`${releaseState.production.sourceCommit}\``), true);
  assert.match(releaseGate, /public surface[\s\S]*exactly 9|exactly 9 tools with no `device\.claim`/i);

  const masterGate = await fs.readFile(path.join(root, 'docs/OPERATOR_MASTER_GATE_STATUS.md'), 'utf8');
  assert.match(masterGate, /G3 MCP Truthfulness & Safety[\s\S]*exactly 9 allowlisted tools/);
  assert.match(masterGate, /G34 OpenAI Metadata Match[\s\S]*exactly the deployed 9-tool Mecord Connect surface/);

  const review = await json('docs/plugin-review-package.json');
  assert.equal(review.sourceSuccessor.pullRequest, null);
  assert.equal(review.sourceSuccessor.branch, 'main');
  assert.equal(review.sourceSuccessor.productionBaseCommit, releaseState.production.sourceCommit);
  assert.equal(review.sourceSuccessor.sourceCommit, null);
  assert.equal(review.sourceSuccessor.sourceCommitPolicy, 'dynamic-main-head-not-a-production-claim');
  assert.equal(review.releaseCandidate.sourceCommit, releaseState.production.sourceCommit);
  assert.equal(review.releaseCandidate.npmPackage, `mecord-connect@${releaseState.versions.runtimePackage}`);
});
test('current release evidence cannot regress to superseded production facts', async () => {
  const releaseState = await json('docs/release-state.json');
  const currentDocs = [
    'README.md',
    'docs/CURRENT_RELEASE_STATE.md',
    'docs/OPERATOR_DEMO_RECORDING_RUNBOOK.md',
    'docs/OPERATOR_FEATURE_GAPS.md',
    'docs/OPERATOR_MASTER_GATE_STATUS.md',
    'docs/OPERATOR_OPENAI_PORTAL_ENTRY_PACKET.md',
    'docs/OPERATOR_OPENAI_RELEASE_CERTIFICATION_2026-09.md',
    'docs/OPERATOR_OWNER_RELEASE_DECISION_PACKET.md',
    'docs/OPERATOR_REAL_OAUTH_PROOF.md',
    'docs/OPERATOR_RELEASE_GATE.md',
    'docs/OPERATOR_REMAINING_HUMAN_GATES.md',
    'docs/SUBMISSION_PACKAGE.md',
    'docs/plugin-review-package.json'
  ];
  const superseded = [
    '3b3b1bff35f8e78519f114b603f98e8acc56cd66',
    'mecord-connect@1.0.0',
    'ROUTE_NO_DEVICE',
    'paired local runtime was offline',
    'device-backed E2E remains pending'
  ];
  for (const relative of currentDocs) {
    const content = await fs.readFile(path.join(root, relative), 'utf8');
    for (const marker of superseded) {
      assert.equal(content.includes(marker), false, `${relative} contains superseded current-state marker: ${marker}`);
    }
  }
  for (const relative of [
    'README.md',
    'docs/CURRENT_RELEASE_STATE.md',
    'docs/OPERATOR_MASTER_GATE_STATUS.md',
    'docs/OPERATOR_OPENAI_RELEASE_CERTIFICATION_2026-09.md',
    'docs/OPERATOR_RELEASE_GATE.md',
    'docs/plugin-review-package.json'
  ]) {
    const content = await fs.readFile(path.join(root, relative), 'utf8');
    assert.equal(content.includes(releaseState.production.sourceCommit), true, `${relative} must identify the current production source`);
  }

  const historicalBootstrap = await fs.readFile(path.join(root, 'docs/OPERATOR_NPM_NAMESPACE_BOOTSTRAP.md'), 'utf8');
  assert.match(historicalBootstrap, /HISTORICAL \/ SUPERSEDED/);
  assert.match(historicalBootstrap, /mecord-connect@1\.0\.0/);
});

test('master gate headline count matches its actual table statuses', async () => {
  const master = await fs.readFile(path.join(root, 'docs/OPERATOR_MASTER_GATE_STATUS.md'), 'utf8');
  const declared = master.match(/Current canonical count: \*\*(\d+) PASS \/ (\d+) BLOCKED \/ (\d+) NOT APPLICABLE\*\*/);
  assert.ok(declared, 'master gate document must declare its canonical count');
  const rows = [...master.matchAll(/^\| G\d+[^|]*\| (PASS|BLOCKED|NOT APPLICABLE) \|/gm)].map((match) => match[1]);
  assert.equal(rows.length, 37, 'G0-G36 must all be present exactly once');
  assert.equal(rows.filter((status) => status === 'PASS').length, Number(declared[1]));
  assert.equal(rows.filter((status) => status === 'BLOCKED').length, Number(declared[2]));
  assert.equal(rows.filter((status) => status === 'NOT APPLICABLE').length, Number(declared[3]));
});

