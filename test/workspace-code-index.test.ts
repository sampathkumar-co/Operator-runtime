import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WorkspaceCodeIndexer } from '../src/core/workspace-code-index.ts';

async function tempWorkspace(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-code-index-'));
}

test('workspace code index extracts symbols, resolves relative imports, and computes reverse impact', async (t) => {
  const root = await tempWorkspace();
  t.after(async () => fs.rm(root, { recursive: true, force: true }));

  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.mkdir(path.join(root, 'test'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'util.ts'), [
    'export function helper(value: string) {',
    '  return value.toUpperCase();',
    '}'
  ].join('\n'));
  await fs.writeFile(path.join(root, 'src', 'main.ts'), [
    "import { helper } from './util';",
    'export const run = () => helper("ok");'
  ].join('\n'));
  await fs.writeFile(path.join(root, 'test', 'main.test.ts'), [
    "import { run } from '../src/main';",
    'export function testRun() { return run(); }'
  ].join('\n'));

  const indexer = new WorkspaceCodeIndexer(root, {
    clock: () => new Date('2026-10-06T00:00:00.000Z')
  });
  const snapshot = await indexer.build();

  assert.match(snapshot.id, /^[0-9a-f]{64}$/);
  assert.equal(snapshot.files.length, 3);

  const util = snapshot.files.find((file) => file.path === 'src/util.ts');
  const main = snapshot.files.find((file) => file.path === 'src/main.ts');
  assert.ok(util);
  assert.ok(main);
  assert.equal(util.symbols.some((symbol) => symbol.name === 'helper' && symbol.kind === 'function' && symbol.exported), true);
  assert.equal(main.imports.find((item) => item.specifier === './util')?.targetPath, 'src/util.ts');

  const symbols = indexer.findSymbols(snapshot, 'help', { mode: 'prefix' });
  assert.deepEqual(symbols.map((item) => [item.path, item.name]), [['src/util.ts', 'helper']]);

  const impact = indexer.impact(snapshot, ['src/util.ts']);
  assert.deepEqual(impact.impactedPaths, ['src/main.ts', 'src/util.ts', 'test/main.test.ts']);
  assert.deepEqual(impact.suggestedTestPaths, ['test/main.test.ts']);
});

test('text search verifies file digests and refuses to return stale content', async (t) => {
  const root = await tempWorkspace();
  t.after(async () => fs.rm(root, { recursive: true, force: true }));

  await fs.writeFile(path.join(root, 'a.ts'), 'export const secretMarker = "alpha";\n');
  const indexer = new WorkspaceCodeIndexer(root, {
    clock: () => new Date('2026-10-06T00:00:00.000Z')
  });
  const snapshot = await indexer.build();

  const before = await indexer.searchText(snapshot, 'secretMarker');
  assert.equal(before.hits.length, 1);
  assert.equal(before.hits[0]?.path, 'a.ts');

  await fs.writeFile(path.join(root, 'a.ts'), 'export const changed = "beta";\n');
  const after = await indexer.searchText(snapshot, 'secretMarker');
  assert.equal(after.hits.length, 0);
  assert.deepEqual(after.stalePaths, ['a.ts']);
});

test('index skips hard-linked source files instead of indexing content with ambiguous ownership', async (t) => {
  const parent = await tempWorkspace();
  t.after(async () => fs.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'workspace');
  await fs.mkdir(root);

  const outside = path.join(parent, 'outside.ts');
  const inside = path.join(root, 'linked.ts');
  await fs.writeFile(outside, 'export const outside = true;\n');
  await fs.link(outside, inside);

  const indexer = new WorkspaceCodeIndexer(root, {
    clock: () => new Date('2026-10-06T00:00:00.000Z')
  });
  const snapshot = await indexer.build();

  assert.equal(snapshot.files.length, 0);
  assert.equal(snapshot.skipped.hardLinkCount, 1);
});

test('index identity is deterministic across observation times', async (t) => {
  const root = await tempWorkspace();
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'sample.py'), [
    'from tools.util import helper',
    'def calculate(value):',
    '    return helper(value)'
  ].join('\n'));

  const first = await new WorkspaceCodeIndexer(root, {
    clock: () => new Date('2026-10-06T00:00:00.000Z')
  }).build();
  const second = await new WorkspaceCodeIndexer(root, {
    clock: () => new Date('2026-10-06T01:00:00.000Z')
  }).build();

  assert.equal(first.id, second.id);
  assert.notEqual(first.observedAt, second.observedAt);
});

test('tampered index snapshot fails closed before symbol or impact queries', async (t) => {
  const root = await tempWorkspace();
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'a.ts'), 'export class Alpha {}\n');

  const indexer = new WorkspaceCodeIndexer(root, {
    clock: () => new Date('2026-10-06T00:00:00.000Z')
  });
  const snapshot = await indexer.build();
  const tampered = structuredClone(snapshot);
  tampered.files[0]!.symbols[0]!.name = 'Injected';

  assert.throws(() => indexer.findSymbols(tampered, 'Injected'), /digest does not match/);
  assert.throws(() => indexer.impact(tampered, ['a.ts']), /digest does not match/);
});
