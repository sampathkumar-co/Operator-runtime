import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { PRODUCT_NAME, PRODUCT_TITLE, PRODUCT_VERSION } from '../src/core/product-identity.ts';
import { PUBLIC_PLUGIN_TOOL_NAMES } from '../src/core/public-plugin-surface.ts';

test('Mecord Connect product identity matches the publishable npm package', async () => {
  const pkg = JSON.parse(await fs.readFile(path.join(process.cwd(), 'packages', 'mecord-connect', 'package.json'), 'utf8'));
  assert.equal(PRODUCT_NAME, 'mecord-connect');
  assert.equal(PRODUCT_TITLE, 'Mecord Connect');
  assert.equal(PRODUCT_VERSION, pkg.version);
  assert.equal(pkg.name, PRODUCT_NAME);
});

test('public tool count is derived from the canonical allowlist', async () => {
  assert.equal(PUBLIC_PLUGIN_TOOL_NAMES.length, 9);
  const readme = await fs.readFile(path.join(process.cwd(), 'README.md'), 'utf8');
  assert.match(readme, new RegExp(`\\*\\*${PUBLIC_PLUGIN_TOOL_NAMES.length} review-bounded tools\\*\\*`));
});

test('MCP server no longer exposes legacy Operator product identity', async () => {
  const source = await fs.readFile(path.join(process.cwd(), 'apps', 'mcp-server', 'src', 'server.ts'), 'utf8');
  assert.doesNotMatch(source, /name:\s*'Operator'/);
  assert.doesNotMatch(source, /title:\s*'Operator'/);
  assert.doesNotMatch(source, /version:\s*'0\.1\.0'/);
});
