import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { WorkspaceEditTransactionProvider } from '../src/capabilities/workspace-edit-transaction.ts';
import {
  WorkspaceEditRollbackProvider,
  rollbackJournalPath
} from '../src/capabilities/workspace-edit-rollback.ts';
import { createMultiFileEditPlan } from '../src/core/multi-file-edit-plan.ts';
import { writeDurableStateText } from '../src/core/durable-state.ts';
import type { ActionRequest } from '../src/core/types.ts';

const JOURNAL_OPTIONS = {
  maxBytes: 4 * 1024 * 1024,
  errorCode: 'WORKSPACE_EDIT_ROLLBACK_CORRUPT',
  invalidMessage: 'Workspace edit rollback journal is invalid.'
} as const;

function digest(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

async function fixture(t: TestContext) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-edit-rollback-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'workspace');
  const stateDir = path.join(parent, 'state');
  await fs.mkdir(root);
  await fs.mkdir(stateDir);
  return { parent, root, stateDir };
}

function txAction(
  id: string,
  root: string,
  plan: ReturnType<typeof createMultiFileEditPlan>
): ActionRequest {
  return {
    id,
    capability: 'workspace.edit.transaction',
    risk: 'write',
    input: { workspaceRoot: root, plan, retainRollback: true },
    provenance: { kind: 'runtime' }
  };
}

function rollbackAction(id: string, root: string, rollbackArtifactId: string): ActionRequest {
  return {
    id,
    capability: 'workspace.edit.rollback',
    risk: 'destructive',
    input: { workspaceRoot: root, rollbackArtifactId },
    provenance: { kind: 'runtime' }
  };
}

test('committed workspace edit can be explicitly rolled back from immutable artifact', async (t) => {
  const { root, stateDir } = await fixture(t);
  const before = 'export const value = 1;\n';
  const after = 'export const value = 2;\n';
  const target = path.join(root, 'value.ts');
  await fs.writeFile(target, before);
  const plan = createMultiFileEditPlan({
    files: [{
      path: 'value.ts',
      expectedSha256: digest(before),
      edits: [{
        start: before.indexOf('1'),
        end: before.indexOf('1') + 1,
        replacement: '2'
      }]
    }]
  });

  const tx = new WorkspaceEditTransactionProvider({ allowedRoots: [root], stateDir });
  const committed = await tx.execute(txAction('edit-rollback-source', root, plan));
  assert.equal(committed.ok, true);
  assert.equal(await fs.readFile(target, 'utf8'), after);
  const rollbackArtifactId = String((committed.output as Record<string, unknown>).rollbackArtifactId ?? '');
  assert.match(rollbackArtifactId, /^[0-9a-f]{64}$/);
  assert.equal((committed.output as Record<string, unknown>).rollbackAvailable, true);

  const provider = new WorkspaceEditRollbackProvider({ allowedRoots: [root], stateDir });
  const action = rollbackAction('edit-rollback-action', root, rollbackArtifactId);
  const result = await provider.execute(action);
  assert.equal(result.ok, true);
  assert.equal(await fs.readFile(target, 'utf8'), before);
  assert.equal((result.output as { planId?: string }).planId, plan.id);

  const repeated = await provider.execute(action);
  assert.equal(repeated.ok, true);
  assert.equal((repeated.output as { reconciled?: boolean }).reconciled, true);
  assert.equal(await fs.readFile(target, 'utf8'), before);
});

test('committed rollback refuses unknown current bytes without overwriting them', async (t) => {
  const { root, stateDir } = await fixture(t);
  const before = 'export const value = 1;\n';
  const target = path.join(root, 'value.ts');
  await fs.writeFile(target, before);
  const plan = createMultiFileEditPlan({
    files: [{
      path: 'value.ts',
      expectedSha256: digest(before),
      edits: [{
        start: before.indexOf('1'),
        end: before.indexOf('1') + 1,
        replacement: '2'
      }]
    }]
  });
  const tx = new WorkspaceEditTransactionProvider({ allowedRoots: [root], stateDir });
  const committed = await tx.execute(txAction('edit-stale-source', root, plan));
  const rollbackArtifactId = String((committed.output as Record<string, unknown>).rollbackArtifactId ?? '');
  const unknown = 'export const value = 999;\n';
  await fs.writeFile(target, unknown);

  const rollback = new WorkspaceEditRollbackProvider({ allowedRoots: [root], stateDir });
  const result = await rollback.execute(rollbackAction('edit-stale-rollback', root, rollbackArtifactId));
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'WORKSPACE_EDIT_ROLLBACK_STALE');
  assert.equal(await fs.readFile(target, 'utf8'), unknown);
});

test('rollback reconciliation resumes crash after committed bytes were moved aside', async (t) => {
  const { root, stateDir } = await fixture(t);
  const before = 'export const value = 1;\n';
  const after = 'export const value = 2;\n';
  const targetLexical = path.join(root, 'value.ts');
  await fs.writeFile(targetLexical, before);
  const plan = createMultiFileEditPlan({
    files: [{
      path: 'value.ts',
      expectedSha256: digest(before),
      edits: [{
        start: before.indexOf('1'),
        end: before.indexOf('1') + 1,
        replacement: '2'
      }]
    }]
  });
  const tx = new WorkspaceEditTransactionProvider({ allowedRoots: [root], stateDir });
  const committed = await tx.execute(txAction('edit-crash-source', root, plan));
  assert.equal(committed.ok, true);
  assert.equal(await fs.readFile(targetLexical, 'utf8'), after);
  const rollbackArtifactId = String((committed.output as Record<string, unknown>).rollbackArtifactId ?? '');

  const realRoot = await fs.realpath(root);
  const target = path.join(realRoot, 'value.ts');
  const tempPath = path.join(realRoot, '.value.ts.rollback-test.tmp');
  const discardPath = path.join(realRoot, '.value.ts.rollback-test.discard');
  await fs.writeFile(tempPath, before);
  await fs.rename(target, discardPath);

  const action = rollbackAction('edit-crash-rollback', root, rollbackArtifactId);
  const now = '2026-10-06T00:00:00.000Z';
  const journal = {
    schemaVersion: 1,
    actionId: action.id,
    rollbackArtifactId,
    transactionActionId: 'edit-crash-source',
    planId: plan.id,
    workspaceRoot: realRoot,
    phase: 'APPLYING',
    files: [{
      path: 'value.ts',
      targetPath: target,
      tempPath,
      discardPath,
      beforeSha256: digest(before),
      afterSha256: digest(after),
      mode: (await fs.stat(tempPath)).mode & 0o777
    }],
    createdAt: now,
    updatedAt: now
  };
  await writeDurableStateText(
    rollbackJournalPath(stateDir, action.id),
    JSON.stringify(journal),
    JOURNAL_OPTIONS
  );

  const restarted = new WorkspaceEditRollbackProvider({ allowedRoots: [root], stateDir });
  const reconciled = await restarted.reconcile({ action });
  assert.equal(reconciled.status, 'completed');
  assert.equal(await fs.readFile(target, 'utf8'), before);
  await assert.rejects(fs.stat(tempPath), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT');
  await assert.rejects(fs.stat(discardPath), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT');
});

test('transaction without retainRollback publishes no rollback artifact', async (t) => {
  const { root, stateDir } = await fixture(t);
  const before = 'const x = 1;\n';
  await fs.writeFile(path.join(root, 'x.ts'), before);
  const plan = createMultiFileEditPlan({
    files: [{
      path: 'x.ts',
      expectedSha256: digest(before),
      edits: [{ start: before.indexOf('1'), end: before.indexOf('1') + 1, replacement: '2' }]
    }]
  });
  const provider = new WorkspaceEditTransactionProvider({ allowedRoots: [root], stateDir });
  const result = await provider.execute({
    id: 'edit-no-rollback',
    capability: 'workspace.edit.transaction',
    risk: 'write',
    input: { workspaceRoot: root, plan },
    provenance: { kind: 'runtime' }
  });
  assert.equal(result.ok, true);
  assert.equal((result.output as Record<string, unknown>).rollbackAvailable, false);
  assert.equal('rollbackArtifactId' in (result.output as Record<string, unknown>), false);
});
