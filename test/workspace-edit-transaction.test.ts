import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { writeDurableStateText, readDurableStateText } from '../src/core/durable-state.ts';
import { createMultiFileEditPlan, applyMultiFileEditPlan } from '../src/core/multi-file-edit-plan.ts';
import {
  WorkspaceEditTransactionProvider,
  workspaceEditTransactionJournalPath,
  type WorkspaceEditTransactionRecord
} from '../src/capabilities/workspace-edit-transaction.ts';
import type { ActionRequest } from '../src/core/types.ts';

const JOURNAL_OPTIONS = {
  maxBytes: 4 * 1024 * 1024,
  errorCode: 'WORKSPACE_EDIT_TRANSACTION_CORRUPT',
  invalidMessage: 'Workspace edit transaction journal is invalid.'
} as const;

function digest(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-edit-tx-'));
  t.after(async () => fs.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'workspace');
  const stateDir = path.join(parent, 'state');
  await fs.mkdir(root);
  await fs.mkdir(stateDir);
  return { parent, root, stateDir };
}

function action(id: string, root: string, plan: ReturnType<typeof createMultiFileEditPlan>): ActionRequest {
  return {
    id,
    capability: 'workspace.edit.transaction',
    risk: 'write',
    input: { workspaceRoot: root, plan },
    provenance: { kind: 'runtime' }
  };
}

test('workspace edit transaction commits all targets and leaves a committed durable receipt', async (t) => {
  const { root, stateDir } = await fixture(t);
  const a = 'export const a = 1;\n';
  const b = 'export const b = 2;\n';
  await fs.writeFile(path.join(root, 'a.ts'), a);
  await fs.writeFile(path.join(root, 'b.ts'), b);

  const plan = createMultiFileEditPlan({
    files: [
      {
        path: 'a.ts',
        expectedSha256: digest(a),
        edits: [{ start: a.indexOf('1'), end: a.indexOf('1') + 1, replacement: '10' }]
      },
      {
        path: 'b.ts',
        expectedSha256: digest(b),
        edits: [{ start: b.indexOf('2'), end: b.indexOf('2') + 1, replacement: '20' }]
      }
    ]
  });
  const provider = new WorkspaceEditTransactionProvider({
    allowedRoots: [root],
    stateDir,
    clock: () => new Date('2026-10-06T00:00:00.000Z')
  });

  const result = await provider.execute(action('tx-success', root, plan));
  assert.equal(result.ok, true);
  assert.equal(await fs.readFile(path.join(root, 'a.ts'), 'utf8'), 'export const a = 10;\n');
  assert.equal(await fs.readFile(path.join(root, 'b.ts'), 'utf8'), 'export const b = 20;\n');

  const journal = JSON.parse(await readDurableStateText(
    workspaceEditTransactionJournalPath(stateDir, 'tx-success'),
    JOURNAL_OPTIONS
  )) as WorkspaceEditTransactionRecord;
  assert.equal(journal.phase, 'COMMITTED');

  const residue = (await fs.readdir(root)).filter((name) => name.includes('.operator-edit-'));
  assert.deepEqual(residue, []);

  const reconciled = await provider.reconcile({ action: action('tx-success', root, plan) });
  assert.equal(reconciled.status, 'completed');
});

test('stale multi-file plan fails before the first mutation and creates no journal', async (t) => {
  const { root, stateDir } = await fixture(t);
  const original = 'export const value = 1;\n';
  const changed = 'export const value = 9;\n';
  await fs.writeFile(path.join(root, 'value.ts'), changed);

  const plan = createMultiFileEditPlan({
    files: [{
      path: 'value.ts',
      expectedSha256: digest(original),
      edits: [{ start: original.indexOf('1'), end: original.indexOf('1') + 1, replacement: '2' }]
    }]
  });
  const provider = new WorkspaceEditTransactionProvider({ allowedRoots: [root], stateDir });
  const result = await provider.execute(action('tx-stale', root, plan));

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'EDIT_PLAN_STALE');
  assert.equal(result.error?.sideEffectState, 'none');
  assert.equal(await fs.readFile(path.join(root, 'value.ts'), 'utf8'), changed);
  await assert.rejects(
    fs.stat(workspaceEditTransactionJournalPath(stateDir, 'tx-stale')),
    (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
});

test('restart reconciliation rolls a partially applied transaction back to exact pre-edit hashes', async (t) => {
  const { root, stateDir } = await fixture(t);
  const beforeA = 'export const a = 1;\n';
  const beforeB = 'export const b = 2;\n';
  const targetA = path.join(root, 'a.ts');
  const targetB = path.join(root, 'b.ts');
  await fs.writeFile(targetA, beforeA);
  await fs.writeFile(targetB, beforeB);

  const plan = createMultiFileEditPlan({
    files: [
      {
        path: 'a.ts',
        expectedSha256: digest(beforeA),
        edits: [{ start: beforeA.indexOf('1'), end: beforeA.indexOf('1') + 1, replacement: '10' }]
      },
      {
        path: 'b.ts',
        expectedSha256: digest(beforeB),
        edits: [{ start: beforeB.indexOf('2'), end: beforeB.indexOf('2') + 1, replacement: '20' }]
      }
    ]
  });
  const applied = applyMultiFileEditPlan(plan, { 'a.ts': beforeA, 'b.ts': beforeB });
  const afterA = applied.contentByPath['a.ts']!;
  const afterB = applied.contentByPath['b.ts']!;

  const backupA = path.join(root, '.a.ts.operator-edit-recovery.bak');
  const tempA = path.join(root, '.a.ts.operator-edit-recovery.tmp');
  const discardA = path.join(root, '.a.ts.operator-edit-recovery.discard');
  const backupB = path.join(root, '.b.ts.operator-edit-recovery.bak');
  const tempB = path.join(root, '.b.ts.operator-edit-recovery.tmp');
  const discardB = path.join(root, '.b.ts.operator-edit-recovery.discard');

  await fs.writeFile(backupA, beforeA);
  await fs.writeFile(targetA, afterA);
  await fs.writeFile(tempB, afterB);

  const modeA = (await fs.stat(targetA)).mode & 0o777;
  const modeB = (await fs.stat(targetB)).mode & 0o777;
  const now = '2026-10-06T00:00:00.000Z';
  const record: WorkspaceEditTransactionRecord = {
    schemaVersion: 1,
    actionId: 'tx-recover',
    workspaceRoot: root,
    planId: plan.id,
    phase: 'APPLYING',
    files: [
      {
        path: 'a.ts',
        targetPath: targetA,
        tempPath: tempA,
        backupPath: backupA,
        discardPath: discardA,
        beforeSha256: digest(beforeA),
        afterSha256: digest(afterA),
        mode: modeA
      },
      {
        path: 'b.ts',
        targetPath: targetB,
        tempPath: tempB,
        backupPath: backupB,
        discardPath: discardB,
        beforeSha256: digest(beforeB),
        afterSha256: digest(afterB),
        mode: modeB
      }
    ],
    createdAt: now,
    updatedAt: now
  };
  await writeDurableStateText(
    workspaceEditTransactionJournalPath(stateDir, 'tx-recover'),
    JSON.stringify(record),
    JOURNAL_OPTIONS
  );

  const restarted = new WorkspaceEditTransactionProvider({
    allowedRoots: [root],
    stateDir,
    clock: () => new Date('2026-10-06T00:00:01.000Z')
  });
  const reconciled = await restarted.reconcile({ action: action('tx-recover', root, plan) });

  assert.equal(reconciled.status, 'not_applied');
  assert.equal(await fs.readFile(targetA, 'utf8'), beforeA);
  assert.equal(await fs.readFile(targetB, 'utf8'), beforeB);
  for (const leftover of [backupA, tempA, discardA, backupB, tempB, discardB]) {
    await assert.rejects(fs.stat(leftover), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT');
  }
  const journal = JSON.parse(await readDurableStateText(
    workspaceEditTransactionJournalPath(stateDir, 'tx-recover'),
    JOURNAL_OPTIONS
  )) as WorkspaceEditTransactionRecord;
  assert.equal(journal.phase, 'ROLLED_BACK');
});

test('reconciliation fails closed and preserves unknown target bytes', async (t) => {
  const { root, stateDir } = await fixture(t);
  const before = 'export const value = 1;\n';
  const after = 'export const value = 2;\n';
  const unknown = 'export const value = 999;\n';
  const target = path.join(root, 'value.ts');
  const backup = path.join(root, '.value.ts.operator-edit-ambiguous.bak');
  const temp = path.join(root, '.value.ts.operator-edit-ambiguous.tmp');
  const discard = path.join(root, '.value.ts.operator-edit-ambiguous.discard');
  await fs.writeFile(target, unknown);
  await fs.writeFile(backup, before);

  const plan = createMultiFileEditPlan({
    files: [{
      path: 'value.ts',
      expectedSha256: digest(before),
      edits: [{ start: before.indexOf('1'), end: before.indexOf('1') + 1, replacement: '2' }]
    }]
  });
  const now = '2026-10-06T00:00:00.000Z';
  const record: WorkspaceEditTransactionRecord = {
    schemaVersion: 1,
    actionId: 'tx-ambiguous',
    workspaceRoot: root,
    planId: plan.id,
    phase: 'APPLYING',
    files: [{
      path: 'value.ts',
      targetPath: target,
      tempPath: temp,
      backupPath: backup,
      discardPath: discard,
      beforeSha256: digest(before),
      afterSha256: digest(after),
      mode: (await fs.stat(target)).mode & 0o777
    }],
    createdAt: now,
    updatedAt: now
  };
  await writeDurableStateText(
    workspaceEditTransactionJournalPath(stateDir, 'tx-ambiguous'),
    JSON.stringify(record),
    JOURNAL_OPTIONS
  );

  const provider = new WorkspaceEditTransactionProvider({ allowedRoots: [root], stateDir });
  const reconciled = await provider.reconcile({ action: action('tx-ambiguous', root, plan) });

  assert.equal(reconciled.status, 'uncertain');
  assert.equal(await fs.readFile(target, 'utf8'), unknown);
  assert.equal(await fs.readFile(backup, 'utf8'), before);
});

test('hard-linked edit targets are rejected before staging', async (t) => {
  const { parent, root, stateDir } = await fixture(t);
  const outside = path.join(parent, 'outside.ts');
  const target = path.join(root, 'linked.ts');
  const before = 'export const linked = true;\n';
  await fs.writeFile(outside, before);
  await fs.link(outside, target);

  const plan = createMultiFileEditPlan({
    files: [{
      path: 'linked.ts',
      expectedSha256: digest(before),
      edits: [{ start: before.indexOf('true'), end: before.indexOf('true') + 4, replacement: 'false' }]
    }]
  });
  const provider = new WorkspaceEditTransactionProvider({ allowedRoots: [root], stateDir });
  const result = await provider.execute(action('tx-hardlink', root, plan));

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'WORKSPACE_EDIT_TARGET_UNSAFE');
  assert.equal(await fs.readFile(target, 'utf8'), before);
  assert.equal(await fs.readFile(outside, 'utf8'), before);
});
