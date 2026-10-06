import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  resolvePhysicalResourceKeysForAction,
  resourceKeysConflict
} from '../src/core/resource-identity.ts';
import type { ActionRequest } from '../src/core/types.ts';

test('LSP edit planning conflicts physically with a concurrent write under the workspace', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-lsp-resource-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'src', 'value.ts');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, 'export const value = 1;\n');

  const planner: ActionRequest = {
    id: 'planner',
    capability: 'workspace.edit.resolve_lsp',
    risk: 'read',
    input: { workspaceRoot: root },
    provenance: { kind: 'runtime' }
  };
  const writer: ActionRequest = {
    id: 'writer',
    capability: 'file.replace',
    risk: 'destructive',
    input: {
      path: target,
      content: 'x',
      expectedSha256: 'a'.repeat(64)
    },
    provenance: { kind: 'runtime' }
  };

  const left = await resolvePhysicalResourceKeysForAction(planner);
  const right = await resolvePhysicalResourceKeysForAction(writer);

  assert.equal(left.some((key) => key.startsWith('fs-path:')), true);
  assert.equal(
    left.some((a) => right.some((b) => resourceKeysConflict(a, b))),
    true
  );
});
