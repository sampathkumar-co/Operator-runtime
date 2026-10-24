import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProjectInspectProvider } from '../src/capabilities/project.ts';
import type { ActionRequest } from '../src/core/types.ts';

async function project(t: test.TestContext, scripts: Record<string, string>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-project-inspect-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: 'generic-project', version: '1.0.0', scripts
  }));
  return { root, provider: new ProjectInspectProvider({ allowedRoots: [root] }) };
}
function request(root: string, offset?: number, maxBytes?: number): ActionRequest {
  return {
    id: 'synthetic-project-inspect', capability: 'project.inspect',
    risk: 'read', input: { path: root, ...(offset === undefined ? {} : { offset }),
      ...(maxBytes === undefined ? {} : { maxBytes }) },
    provenance: { kind: 'runtime' }
  };
}
type Page = {
  scripts: Record<string, string>;
  scriptPage?: { offset: number; nextOffset: number | null; total: number; sourceSha256: string };
};

test('small projects retain original semantic inspection shape', async t => {
  const { root, provider } = await project(t, { lint: 'node scripts/lint.mjs', check: 'node --test' });
  const result = await provider.execute(request(root));
  assert.equal(result.ok, true);
  const output = result.output as Page;
  assert.deepEqual(output.scripts, { lint: 'node scripts/lint.mjs', check: 'node --test' });
  assert.equal(output.scriptPage, undefined);
});

test('oversized scripts are bounded and exhaustively pageable without duplicates', async t => {
  const scripts = Object.fromEntries(Array.from({ length: 35 }, (_, i) => [
    `scenario_${String(i).padStart(2, '0')}`, `node ./scripts/check-${i}.mjs ${'x'.repeat(75)}`
  ]));
  const { root, provider } = await project(t, scripts);
  let offset = 0;
  let digest: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < 35; page += 1) {
    const result = await provider.execute(request(root, offset, 1024));
    assert.equal(result.ok, true);
    assert.ok(Buffer.byteLength(JSON.stringify(result.output), 'utf8') <= 1024);
    const output = result.output as Page;
    assert.equal(output.scriptPage?.offset, offset);
    assert.equal(output.scriptPage?.total, 35);
    assert.match(output.scriptPage?.sourceSha256 ?? '', /^[0-9a-f]{64}$/);
    if (digest) assert.equal(output.scriptPage?.sourceSha256, digest);
    digest = output.scriptPage?.sourceSha256;
    for (const name of Object.keys(output.scripts)) {
      assert.equal(seen.has(name), false);
      seen.add(name);
      assert.equal(output.scripts[name], scripts[name]);
    }
    const nextOffset = output.scriptPage?.nextOffset;
    if (nextOffset === null) break;
    assert.ok(nextOffset !== undefined && nextOffset > offset);
    offset = nextOffset!;
  }
  assert.deepEqual(new Set(Object.keys(scripts)), seen);
});

test('single script entry larger than budget fails instead of yielding a stuck continuation', async t => {
  const { root, provider } = await project(t, { overlong: 'x'.repeat(4000) });
  await assert.rejects(
    () => provider.execute(request(root, 0, 1024)),
    (error: any) => error?.code === 'PROJECT_INSPECT_ENTRY_EXCEEDS_BUDGET'
  );
});

test('invalid script-page parameters fail closed and do not widen the public output limit', async t => {
  const { root, provider } = await project(t, { test: 'node --test' });
  for (const input of [{ offset: -1 }, { offset: '1' }, { maxBytes: 500 }, { maxBytes: 200_000 }]) {
    await assert.rejects(
      () => provider.execute({ ...request(root), input: { path: root, ...input } }),
      (error: any) => error?.code === 'PROJECT_INSPECT_PAGINATION_INVALID'
    );
  }
});

test('offset beyond final script returns a clearly exhausted page', async t => {
  const { root, provider } = await project(t, { build: 'node build.mjs' });
  const result = await provider.execute(request(root, 90, 1024));
  assert.equal(result.ok, true);
  const output = result.output as Page;
  assert.deepEqual(Object.keys(output.scripts), []);
  assert.equal(output.scriptPage?.total, 1);
  assert.equal(output.scriptPage?.nextOffset, null);
});

test('public tool forwards declared offset and maxBytes to the semantic provider', async () => {
  const source = await fs.readFile(path.join(process.cwd(), 'apps/mcp-server/src/public-tools.ts'), 'utf8');
  assert.match(source, /async \(\{ path, offset, maxBytes \}\) => invoke\('project\.inspect', 'read', \{ path, offset, maxBytes \}, path\)/);
});
