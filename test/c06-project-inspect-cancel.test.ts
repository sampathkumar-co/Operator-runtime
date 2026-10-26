import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectInspectProvider } from '../src/capabilities/project.ts';

test('C06 cancelled project inspection never reads a manifest or returns success', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-c06-inspect-stop-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: 'cancel-fixture', scripts: { test: 'echo fixture' }
  }));
  const provider = new ProjectInspectProvider({ allowedRoots: [root] });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(provider.execute({
    id: 'project-stop-before-observation', capability: 'project.inspect', risk: 'read',
    input: { path: root }, provenance: { kind: 'runtime' }
  }, { signal: controller.signal }), (error: any) =>
    error?.code === 'EXECUTION_ABORTED' &&
    error?.details?.sideEffectState === 'none' &&
    error?.details?.executionPhase === 'pre_dispatch');
});

test('C06 uncancelled project inspection still returns bounded semantic metadata', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-c06-inspect-active-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: 'active-fixture', scripts: { test: 'node --test' }
  }));
  const provider = new ProjectInspectProvider({ allowedRoots: [root] });
  const result = await provider.execute({
    id: 'project-ordinary-inspect', capability: 'project.inspect', risk: 'read',
    input: { path: root }, provenance: { kind: 'runtime' }
  }, { signal: new AbortController().signal });
  assert.equal(result.ok, true);
  assert.ok(result.evidence.some(x => x.kind === 'project_model'));
});
