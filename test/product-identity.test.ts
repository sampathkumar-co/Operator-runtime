import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { PRODUCT_NAME, PRODUCT_TITLE, PRODUCT_VERSION } from '../src/core/product-identity.ts';
import { PUBLIC_PLUGIN_SURFACE_VERSION, PUBLIC_PLUGIN_TOOL_NAMES } from '../src/core/public-plugin-surface.ts';

test('Mecord Connect public product and npm runtime identities remain compatible', async () => {
  const pkg = JSON.parse(await fs.readFile(path.join(process.cwd(), 'packages', 'mecord-connect', 'package.json'), 'utf8'));
  assert.equal(PRODUCT_NAME, 'mecord-connect');
  assert.equal(PRODUCT_TITLE, 'Mecord Connect');
  assert.match(PRODUCT_VERSION, /^\d+\.\d+\.\d+$/);
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(pkg.name, PRODUCT_NAME);
  assert.equal(pkg.version.split('.')[0], PRODUCT_VERSION.split('.')[0], 'npm runtime major must remain compatible with public product major');
});

test('public tool count is derived from the canonical allowlist', async () => {
  assert.equal(PUBLIC_PLUGIN_TOOL_NAMES.length, 9);
  assert.equal(PUBLIC_PLUGIN_SURFACE_VERSION, 1);
  const readme = await fs.readFile(path.join(process.cwd(), 'README.md'), 'utf8');
  assert.match(readme, new RegExp(`\\*\\*${PUBLIC_PLUGIN_TOOL_NAMES.length} review-bounded tools\\*\\*`));
});

test('runtime health surfaces no longer expose legacy product version or Operator MCP identity', async () => {
  const mcp = await fs.readFile(path.join(process.cwd(), 'apps', 'mcp-server', 'src', 'server.ts'), 'utf8');
  const agent = await fs.readFile(path.join(process.cwd(), 'apps', 'local-agent', 'src', 'server.ts'), 'utf8');
  assert.doesNotMatch(mcp, /name:\s*'Operator'/);
  assert.doesNotMatch(mcp, /title:\s*'Operator'/);
  assert.doesNotMatch(mcp, /version:\s*'0\.1\.0'/);
  assert.doesNotMatch(agent, /version:\s*'0\.1\.0'/);
  assert.match(agent, /version:\s*PRODUCT_VERSION/);
  assert.match(mcp, /publicToolSurfaceVersion:\s*PUBLIC_PLUGIN_SURFACE_VERSION/);
  assert.match(mcp, /publicToolCount:\s*PUBLIC_PLUGIN_TOOL_NAMES\.length/);
});
