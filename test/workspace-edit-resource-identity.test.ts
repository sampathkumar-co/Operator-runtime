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

test('workspace edit capabilities have canonical write risk', () => {
  assert.equal(capabilityRiskRule('workspace.edit.transaction'), 'write');
  assert.equal(capabilityRiskRule('workspace.edit.verified'), 'write');
});

test('verified and transactional workspace edits lease the physical edited files', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-edit-resource-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'src', 'value.ts');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, 'export const value = 1;\n');

  const plan = {
    schemaVersion: 1,
    id: 'a'.repeat(64),
    files: [{
      path: 'src/value.ts',
      expectedSha256: 'b'.repeat(64),
      edits: [{ start: 0, end: 0, replacement: '' }]
    }],
    verification: { trustedCommandIds: ['test'], requiredTestPaths: [] }
  };

  const makeEdit = (capability: string): ActionRequest => ({
    id: capability,
    capability,
    risk: 'write',
    input: { workspaceRoot: root, plan },
    provenance: { kind: 'runtime' }
  });

  const transactionKeys = await resolvePhysicalResourceKeysForAction(makeEdit('workspace.edit.transaction'));
  const verifiedKeys = await resolvePhysicalResourceKeysForAction(makeEdit('workspace.edit.verified'));
  const fileKeys = await resolvePhysicalResourceKeysForAction({
    id: 'replace',
    capability: 'file.replace',
    risk: 'destructive',
    input: { path: target, content: 'x', expectedSha256: 'b'.repeat(64) },
    provenance: { kind: 'runtime' }
  });

  const conflicts = (left: string[], right: string[]) =>
    left.some((a) => right.some((b) => resourceKeysConflict(a, b)));

  assert.equal(conflicts(transactionKeys, verifiedKeys), true);
  assert.equal(conflicts(transactionKeys, fileKeys), true);
  assert.equal(conflicts(verifiedKeys, fileKeys), true);
  assert.equal(verifiedKeys.some((key) => key.startsWith('fs-path:')), true);
  assert.equal(verifiedKeys.some((key) => key.startsWith('fs-object:')), true);
});
