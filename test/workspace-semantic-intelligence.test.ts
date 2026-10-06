import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WorkspaceCodeIndexer } from '../src/core/workspace-code-index.ts';
import {
  WorkspaceSemanticIntelligence,
  analyzeSemanticThreeWayConflict
} from '../src/core/workspace-semantic-intelligence.ts';

test('semantic intelligence builds declaration tree and resolves unique call edges', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-semantic-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src', 'util.ts'), [
    'export function helper(value: string) {',
    '  return value.toUpperCase();',
    '}',
    ''
  ].join('\n'));
  await fs.writeFile(path.join(root, 'src', 'main.ts'), [
    "import { helper } from './util';",
    'export function run() {',
    '  return helper("ok");',
    '}',
    ''
  ].join('\n'));

  const indexer = new WorkspaceCodeIndexer(root, {
    clock: () => new Date('2026-10-06T00:00:00.000Z')
  });
  const index = await indexer.build();
  const semantic = new WorkspaceSemanticIntelligence(root);
  const snapshot = await semantic.build(index);

  assert.match(snapshot.id, /^[0-9a-f]{64}$/);
  const helper = semantic.searchSyntax(snapshot, { name: 'helper', nameMode: 'exact' });
  const run = semantic.searchSyntax(snapshot, { name: 'run', nameMode: 'exact' });
  assert.equal(helper.length, 1);
  assert.equal(run.length, 1);
  assert.equal(helper[0]?.startLine, 1);
  assert.ok((helper[0]?.endLine ?? 0) >= 3);

  const callers = semantic.callers(snapshot, helper[0]!.id);
  assert.equal(callers.length, 1);
  assert.equal(callers[0]?.fromNodeId, run[0]!.id);
  assert.equal(callers[0]?.callee, 'helper');

  const callees = semantic.callees(snapshot, run[0]!.id);
  assert.equal(callees.some((edge) => edge.resolvedNodeId === helper[0]!.id), true);
});

test('semantic intelligence refuses stale source bytes after code-index observation', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-semantic-stale-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'a.ts');
  await fs.writeFile(file, 'export function alpha() { return 1; }\n');

  const index = await new WorkspaceCodeIndexer(root).build();
  await fs.writeFile(file, 'export function alpha() { return 2; }\n');

  await assert.rejects(
    () => new WorkspaceSemanticIntelligence(root).build(index),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'WORKSPACE_SEMANTIC_STALE');
      return true;
    }
  );
});

test('three-way semantic conflict assistance distinguishes disjoint and overlapping symbols', () => {
  const base = [
    'export function alpha() {',
    '  return 1;',
    '}',
    '',
    'export function beta() {',
    '  return 2;',
    '}',
    ''
  ].join('\n');
  const current = base.replace('return 1;', 'return 10;');
  const planned = base.replace('return 2;', 'return 20;');

  const disjoint = analyzeSemanticThreeWayConflict({
    language: 'typescript',
    base,
    current,
    planned
  });
  assert.equal(disjoint.status, 'MERGEABLE_DISJOINT_SYMBOLS');
  assert.deepEqual(disjoint.currentChangedSymbols, ['alpha']);
  assert.deepEqual(disjoint.plannedChangedSymbols, ['beta']);
  assert.deepEqual(disjoint.overlappingSymbols, []);

  const conflict = analyzeSemanticThreeWayConflict({
    language: 'typescript',
    base,
    current,
    planned: base.replace('return 1;', 'return 99;')
  });
  assert.equal(conflict.status, 'CONFLICTING_SYMBOLS');
  assert.deepEqual(conflict.overlappingSymbols, ['alpha']);
});

test('changes outside known declarations remain ambiguous instead of being auto-mergeable', () => {
  const base = 'const config = 1;\nexport function run() { return config; }\n';
  const current = base.replace('const config = 1;', 'const config = 2;');
  const planned = base.replace('const config = 1;', 'const config = 3;');
  const result = analyzeSemanticThreeWayConflict({
    language: 'typescript',
    base,
    current,
    planned
  });
  assert.equal(result.status, 'AMBIGUOUS');
  assert.equal(result.unscopedCurrentChange, true);
  assert.equal(result.unscopedPlannedChange, true);
});
