import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createMultiFileEditPlan } from '../src/core/multi-file-edit-plan.ts';
import { WorkspaceEditTransactionProvider } from '../src/capabilities/workspace-edit-transaction.ts';
import { VerifiedWorkspaceEditProvider } from '../src/capabilities/verified-workspace-edit.ts';
import type { ActionRequest } from '../src/core/types.ts';

function digest(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

async function fixture(t: test.TestContext) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-verified-edit-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'workspace');
  const authority = path.join(parent, 'authority');
  const stateDir = path.join(parent, 'state');
  await fs.mkdir(root);
  await fs.mkdir(authority);
  await fs.mkdir(stateDir);
  return {
    root,
    stateDir,
    registryPath: path.join(authority, 'project-commands.json')
  };
}

async function writeRegistry(
  registryPath: string,
  root: string,
  commands: Array<Record<string, unknown>>
): Promise<void> {
  await fs.writeFile(registryPath, JSON.stringify({
    version: 1,
    projects: [{ root, commands }]
  }, null, 2));
}

function verifiedAction(
  id: string,
  root: string,
  plan: ReturnType<typeof createMultiFileEditPlan>
): ActionRequest {
  return {
    id,
    capability: 'workspace.edit.verified',
    risk: 'write',
    input: { workspaceRoot: root, plan },
    provenance: { kind: 'runtime' }
  };
}

test('verified workspace edit finalizes only after trusted verifier passes', async (t) => {
  const { root, stateDir, registryPath } = await fixture(t);
  const before = 'export const value = 1;\n';
  await fs.writeFile(path.join(root, 'value.ts'), before);
  await writeRegistry(registryPath, root, [{
    id: 'verify-value',
    kind: 'test',
    executable: 'node',
    args: ['-e', "const fs=require('fs');const t=fs.readFileSync('value.ts','utf8');process.exit(t.includes('value = 2')?0:3)"],
    cwd: '.',
    risk: 'read'
  }]);

  const plan = createMultiFileEditPlan({
    files: [{
      path: 'value.ts',
      expectedSha256: digest(before),
      edits: [{ start: before.indexOf('1'), end: before.indexOf('1') + 1, replacement: '2' }]
    }],
    verification: { trustedCommandIds: ['verify-value'] }
  });

  const provider = new VerifiedWorkspaceEditProvider({
    allowedRoots: [root],
    allowedExecutables: ['node'],
    stateDir,
    registryPath
  });
  const action = verifiedAction('verified-success', root, plan);
  const result = await provider.execute(action);

  assert.equal(result.ok, true, result.error?.message);
  assert.equal(await fs.readFile(path.join(root, 'value.ts'), 'utf8'), 'export const value = 2;\n');
  assert.equal((result.output as any).verificationPassed, true);
  assert.deepEqual((result.output as any).verification.map((item: any) => [item.commandId, item.ok]), [['verify-value', true]]);
  assert.deepEqual((await fs.readdir(root)).filter((name) => name.includes('.operator-edit-')), []);

  const reconciled = await provider.reconcile({ action });
  assert.equal(reconciled.status, 'completed');
});

test('failed trusted verifier rolls exact edited files back', async (t) => {
  const { root, stateDir, registryPath } = await fixture(t);
  const before = 'export const value = 1;\n';
  await fs.writeFile(path.join(root, 'value.ts'), before);
  await writeRegistry(registryPath, root, [{
    id: 'verify-fail',
    kind: 'test',
    executable: 'node',
    args: ['-e', 'process.exit(7)'],
    cwd: '.',
    risk: 'read'
  }]);

  const plan = createMultiFileEditPlan({
    files: [{
      path: 'value.ts',
      expectedSha256: digest(before),
      edits: [{ start: before.indexOf('1'), end: before.indexOf('1') + 1, replacement: '2' }]
    }],
    verification: { trustedCommandIds: ['verify-fail'] }
  });
  const provider = new VerifiedWorkspaceEditProvider({
    allowedRoots: [root],
    allowedExecutables: ['node'],
    stateDir,
    registryPath
  });

  const result = await provider.execute(verifiedAction('verified-fail', root, plan));
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'WORKSPACE_EDIT_VERIFICATION_FAILED_ROLLED_BACK');
  assert.equal(result.error?.sideEffectState, 'none');
  assert.equal((result.output as any).rollbackPerformed, true);
  assert.equal(await fs.readFile(path.join(root, 'value.ts'), 'utf8'), before);
  assert.deepEqual((await fs.readdir(root)).filter((name) => name.includes('.operator-edit-')), []);
});

test('mutating verifier declaration is rejected before edits are staged', async (t) => {
  const { root, stateDir, registryPath } = await fixture(t);
  const before = 'export const value = 1;\n';
  await fs.writeFile(path.join(root, 'value.ts'), before);
  await writeRegistry(registryPath, root, [{
    id: 'format-source',
    kind: 'format',
    executable: 'node',
    args: ['-e', "require('fs').writeFileSync('value.ts','bad')"],
    cwd: '.',
    risk: 'write'
  }]);

  const plan = createMultiFileEditPlan({
    files: [{
      path: 'value.ts',
      expectedSha256: digest(before),
      edits: [{ start: before.indexOf('1'), end: before.indexOf('1') + 1, replacement: '2' }]
    }],
    verification: { trustedCommandIds: ['format-source'] }
  });
  const provider = new VerifiedWorkspaceEditProvider({
    allowedRoots: [root],
    allowedExecutables: ['node'],
    stateDir,
    registryPath
  });

  const result = await provider.execute(verifiedAction('verified-mutating-denied', root, plan));
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'VERIFIED_WORKSPACE_EDIT_VERIFIER_MUTATING');
  assert.equal(result.error?.sideEffectState, 'none');
  assert.equal(await fs.readFile(path.join(root, 'value.ts'), 'utf8'), before);
});

test('restart reruns verifier for held edit and then finalizes', async (t) => {
  const { root, stateDir, registryPath } = await fixture(t);
  const before = 'export const value = 1;\n';
  await fs.writeFile(path.join(root, 'value.ts'), before);
  await writeRegistry(registryPath, root, [{
    id: 'verify-restart',
    kind: 'test',
    executable: 'node',
    args: ['-e', "const fs=require('fs');process.exit(fs.readFileSync('value.ts','utf8').includes('value = 2')?0:4)"],
    cwd: '.',
    risk: 'read'
  }]);

  const plan = createMultiFileEditPlan({
    files: [{
      path: 'value.ts',
      expectedSha256: digest(before),
      edits: [{ start: before.indexOf('1'), end: before.indexOf('1') + 1, replacement: '2' }]
    }],
    verification: { trustedCommandIds: ['verify-restart'] }
  });
  const outer = verifiedAction('verified-restart', root, plan);
  const internal: ActionRequest = {
    id: outer.id + ':edit',
    capability: 'workspace.edit.transaction',
    risk: 'write',
    input: { workspaceRoot: root, plan, deferFinalization: true },
    provenance: { kind: 'trusted_policy', source: outer.id }
  };

  const tx = new WorkspaceEditTransactionProvider({ allowedRoots: [root], stateDir });
  const held = await tx.execute(internal);
  assert.equal(held.ok, true, held.error?.message);
  assert.equal((held.output as any).pendingVerification, true);
  assert.equal(await fs.readFile(path.join(root, 'value.ts'), 'utf8'), 'export const value = 2;\n');
  assert.equal((await fs.readdir(root)).some((name) => name.endsWith('.bak')), true);

  const restarted = new VerifiedWorkspaceEditProvider({
    allowedRoots: [root],
    allowedExecutables: ['node'],
    stateDir,
    registryPath
  });
  const result = await restarted.execute(outer);
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(await fs.readFile(path.join(root, 'value.ts'), 'utf8'), 'export const value = 2;\n');
  assert.deepEqual((await fs.readdir(root)).filter((name) => name.includes('.operator-edit-')), []);
});

test('verifier that violates read declaration cannot silently finalize unknown bytes', async (t) => {
  const { root, stateDir, registryPath } = await fixture(t);
  const before = 'export const value = 1;\n';
  await fs.writeFile(path.join(root, 'value.ts'), before);
  await writeRegistry(registryPath, root, [{
    id: 'lying-verifier',
    kind: 'test',
    executable: 'node',
    args: ['-e', "require('fs').writeFileSync('value.ts','export const value = 999;\\n')"],
    cwd: '.',
    risk: 'read'
  }]);

  const plan = createMultiFileEditPlan({
    files: [{
      path: 'value.ts',
      expectedSha256: digest(before),
      edits: [{ start: before.indexOf('1'), end: before.indexOf('1') + 1, replacement: '2' }]
    }],
    verification: { trustedCommandIds: ['lying-verifier'] }
  });
  const provider = new VerifiedWorkspaceEditProvider({
    allowedRoots: [root],
    allowedExecutables: ['node'],
    stateDir,
    registryPath
  });
  const action = verifiedAction('verified-liar', root, plan);
  const result = await provider.execute(action);

  assert.equal(result.ok, false);
  assert.equal(result.error?.sideEffectState, 'uncertain');
  assert.equal(await fs.readFile(path.join(root, 'value.ts'), 'utf8'), 'export const value = 999;\n');

  const reconciled = await provider.reconcile({ action });
  assert.equal(reconciled.status, 'uncertain');
});
