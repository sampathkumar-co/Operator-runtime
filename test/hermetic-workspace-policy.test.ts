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

test('hermetic workspace operations have canonical risk classes', () => {
  assert.equal(capabilityRiskRule('workspace.hermetic.provision'), 'write');
  assert.equal(capabilityRiskRule('workspace.hermetic.inspect'), 'read');
  assert.equal(capabilityRiskRule('workspace.hermetic.release'), 'destructive');
});

test('hermetic provision conflicts with concurrent Git mutations on the source repository', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-hermetic-resource-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const provision: ActionRequest = {
    id: 'hermetic-provision',
    capability: 'workspace.hermetic.provision',
    risk: 'write',
    input: {
      sourceRoot: root,
      sessionId: 'session-one',
      expectedHead: 'a'.repeat(40)
    },
    provenance: { kind: 'runtime' }
  };
  const gitWrite: ActionRequest = {
    id: 'git-write',
    capability: 'git.write',
    risk: 'write',
    input: { cwd: root, operation: 'stage', paths: ['x'] },
    provenance: { kind: 'runtime' }
  };

  const left = await resolvePhysicalResourceKeysForAction(provision);
  const right = await resolvePhysicalResourceKeysForAction(gitWrite);
  const conflict = left.some((a) => right.some((b) => resourceKeysConflict(a, b)));

  assert.equal(conflict, true);
  assert.equal(left.some((key) => key === 'workspace-session:session-one'), true);
  assert.equal(left.some((key) => key.startsWith('fs-path:')), true);
});

test('all operations for the same hermetic session share a session lease key', async () => {
  const make = (capability: string, risk: ActionRequest['risk']): ActionRequest => ({
    id: capability,
    capability,
    risk,
    input: {
      sessionId: 'shared-session',
      sourceRoot: process.cwd(),
      expectedHead: 'a'.repeat(40),
      expectedManifestId: 'b'.repeat(64)
    },
    provenance: { kind: 'runtime' }
  });

  const provision = await resolvePhysicalResourceKeysForAction(make('workspace.hermetic.provision', 'write'));
  const inspect = await resolvePhysicalResourceKeysForAction(make('workspace.hermetic.inspect', 'read'));
  const release = await resolvePhysicalResourceKeysForAction(make('workspace.hermetic.release', 'destructive'));

  for (const keys of [provision, inspect, release]) {
    assert.equal(keys.includes('workspace-session:shared-session'), true);
  }
});
