import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { capabilityRiskRule } from '../src/core/capability-policy.ts';
import {
  resolvePhysicalResourceKeysForAction,
  resourceKeysConflict
} from '../src/core/resource-identity.ts';
import type { ActionRequest } from '../src/core/types.ts';

test('workspace edit transaction has canonical write risk', () => {
  assert.equal(capabilityRiskRule('workspace.edit.transaction'), 'write');
});

test('workspace transaction conflicts with direct file mutation on an edited target', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-edit-resource-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'src', 'value.ts');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, 'export const value = 1;\n');

  const transaction: ActionRequest = {
    id: 'tx',
    capability: 'workspace.edit.transaction',
    risk: 'write',
    input: {
      workspaceRoot: root,
      plan: {
        schemaVersion: 1,
        id: 'a'.repeat(64),
        files: [{
          path: 'src/value.ts',
          expectedSha256: 'b'.repeat(64),
          edits: [{ start: 0, end: 0, replacement: '' }]
        }],
        verification: { trustedCommandIds: [], requiredTestPaths: [] }
      }
    },
    provenance: { kind: 'runtime' }
  };

  const direct: ActionRequest = {
    id: 'direct',
    capability: 'file.replace',
    risk: 'destructive',
    input: {
      path: target,
      content: 'x',
      expectedSha256: 'b'.repeat(64)
    },
    provenance: { kind: 'runtime' }
  };

  const left = await resolvePhysicalResourceKeysForAction(transaction);
  const right = await resolvePhysicalResourceKeysForAction(direct);
  const conflict = left.some((a) => right.some((b) => resourceKeysConflict(a, b)));

  assert.equal(conflict, true);
  assert.equal(left.some((key) => key.startsWith('fs-path:')), true);
  assert.equal(left.some((key) => key.startsWith('fs-object:')), true);
});
