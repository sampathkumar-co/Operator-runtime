import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { writeDurableStateText, readDurableStateText } from '../src/core/durable-state.ts';
import { withDurableStateLock } from '../src/core/durable-state-lock.ts';
import { createMultiFileEditPlan, applyMultiFileEditPlan } from '../src/core/multi-file-edit-plan.ts';
import {
  WorkspaceEditTransactionProvider,
  workspaceEditTransactionJournalPath,
  workspaceEditTransactionCoordinatorPath,
  type WorkspaceEditTransactionRecord
} from '../src/capabilities/workspace-edit-transaction.ts';
import type { ActionRequest } from '../src/core/types.ts';

const WINDOWS_PATH_LEASE_EXECUTABLE = process.platform === 'win32'
  ? path.resolve('native/windows-path-lease/target/release/operator-windows-path-lease.exe')
  : undefined;

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
    windowsPathLeaseExecutable: WINDOWS_PATH_LEASE_EXECUTABLE,
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
  const provider = new WorkspaceEditTransactionProvider({ allowedRoots: [root], stateDir, windowsPathLeaseExecutable: WINDOWS_PATH_LEASE_EXECUTABLE });
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
  const targetAInput = path.join(root, 'a.ts');
  const targetBInput = path.join(root, 'b.ts');
  await fs.writeFile(targetAInput, beforeA);
  await fs.writeFile(targetBInput, beforeB);
  const canonicalRoot = await fs.realpath(root);
  const targetA = path.join(canonicalRoot, 'a.ts');
  const targetB = path.join(canonicalRoot, 'b.ts');

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

  const backupA = path.join(canonicalRoot, '.a.ts.operator-edit-recovery.bak');
  const tempA = path.join(canonicalRoot, '.a.ts.operator-edit-recovery.tmp');
  const discardA = path.join(canonicalRoot, '.a.ts.operator-edit-recovery.discard');
  const backupB = path.join(canonicalRoot, '.b.ts.operator-edit-recovery.bak');
  const tempB = path.join(canonicalRoot, '.b.ts.operator-edit-recovery.tmp');
  const discardB = path.join(canonicalRoot, '.b.ts.operator-edit-recovery.discard');

  await fs.writeFile(backupA, beforeA);
  await fs.writeFile(targetA, afterA);
  await fs.writeFile(tempB, afterB);

  const modeA = (await fs.stat(targetA)).mode & 0o777;
  const modeB = (await fs.stat(targetB)).mode & 0o777;
  const now = '2026-10-06T00:00:00.000Z';
  const record: WorkspaceEditTransactionRecord = {
    schemaVersion: 1,
    actionId: 'tx-recover',
    workspaceRoot: canonicalRoot,
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
    windowsPathLeaseExecutable: WINDOWS_PATH_LEASE_EXECUTABLE,
    clock: () => new Date('2026-10-06T00:00:01.000Z')
  });
  const reconciled = await restarted.reconcile({ action: action('tx-recover', root, plan) });

  assert.equal(reconciled.status, 'not_applied', JSON.stringify(reconciled.evidence));
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
  const targetInput = path.join(root, 'value.ts');
  await fs.writeFile(targetInput, unknown);
  const canonicalRoot = await fs.realpath(root);
  const target = path.join(canonicalRoot, 'value.ts');
  const backup = path.join(canonicalRoot, '.value.ts.operator-edit-ambiguous.bak');
  const temp = path.join(canonicalRoot, '.value.ts.operator-edit-ambiguous.tmp');
  const discard = path.join(canonicalRoot, '.value.ts.operator-edit-ambiguous.discard');
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
    workspaceRoot: canonicalRoot,
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

  const provider = new WorkspaceEditTransactionProvider({ allowedRoots: [root], stateDir, windowsPathLeaseExecutable: WINDOWS_PATH_LEASE_EXECUTABLE });
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
  const provider = new WorkspaceEditTransactionProvider({ allowedRoots: [root], stateDir, windowsPathLeaseExecutable: WINDOWS_PATH_LEASE_EXECUTABLE });
  const result = await provider.execute(action('tx-hardlink', root, plan));

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'WORKSPACE_EDIT_TARGET_UNSAFE');
  assert.equal(await fs.readFile(target, 'utf8'), before);
  assert.equal(await fs.readFile(outside, 'utf8'), before);
});



test('R3 private deferred edit retains exact backup until explicit trusted finalization', async t => {
  const { root, stateDir } = await fixture(t);
  const original = 'export const value = 1;\n';
  await fs.writeFile(path.join(root,'value.ts'),original);
  const plan = createMultiFileEditPlan({
    files:[{path:'value.ts',expectedSha256:digest(original),
      edits:[{start:original.indexOf('1'),end:original.indexOf('1')+1,replacement:'2'}]}],
    verification:{trustedCommandIds:['registered-test']}
  });
  const tx=new WorkspaceEditTransactionProvider({
    allowedRoots:[root],stateDir,windowsPathLeaseExecutable:WINDOWS_PATH_LEASE_EXECUTABLE
  });
  const a=action('r3-held-finalize',root,plan);
  const held=await tx.executeDeferred(a);
  assert.equal(held.ok,true,held.error?.message);
  assert.equal((held.output as any).pendingVerification,true);
  assert.equal(await fs.readFile(path.join(root,'value.ts'),'utf8'),'export const value = 2;\n');
  const heldRecord=JSON.parse(await readDurableStateText(
    workspaceEditTransactionJournalPath(stateDir,a.id),JOURNAL_OPTIONS
  )) as WorkspaceEditTransactionRecord;
  assert.equal(heldRecord.phase,'VERIFICATION_PENDING');
  assert.equal(heldRecord.requiresVerification,true,
    'verifier fence must survive crashes from PREPARED through APPLYING');
  assert.equal((await fs.stat(heldRecord.files[0]!.backupPath)).isFile(),true);

  const restarted=new WorkspaceEditTransactionProvider({
    allowedRoots:[root],stateDir,windowsPathLeaseExecutable:WINDOWS_PATH_LEASE_EXECUTABLE
  });
  const before=await restarted.reconcile({action:a});
  assert.equal(before.status,'uncertain');
  assert.equal((await restarted.execute(a)).ok,false,
    'the normal public execution path must never silently finalize a held edit');
  const finalized=await restarted.finalizeDeferred(a);
  assert.equal(finalized.ok,true);
  assert.equal(await fs.readFile(path.join(root,'value.ts'),'utf8'),'export const value = 2;\n');
  assert.equal((JSON.parse(await readDurableStateText(
    workspaceEditTransactionJournalPath(stateDir,a.id),JOURNAL_OPTIONS
  )) as WorkspaceEditTransactionRecord).phase,'COMMITTED');
  assert.deepEqual((await fs.readdir(root)).filter(x=>x.includes('.operator-edit-')),[]);
  await assert.rejects(()=>restarted.finalizeDeferred(a),
    (e:any)=>e?.code==='WORKSPACE_EDIT_DEFERRED_PHASE_INVALID');
});

test('R3 failed trusted verification restores the exact pre-edit bytes from held backup', async t => {
  const {root,stateDir}=await fixture(t);
  const initial='let count = 1;\n';
  await fs.writeFile(path.join(root,'count.ts'),initial);
  const plan=createMultiFileEditPlan({
    files:[{path:'count.ts',expectedSha256:digest(initial),
      edits:[{start:initial.indexOf('1'),end:initial.indexOf('1')+1,replacement:'3'}]}]
  });
  const tx=new WorkspaceEditTransactionProvider({
    allowedRoots:[root],stateDir,windowsPathLeaseExecutable:WINDOWS_PATH_LEASE_EXECUTABLE
  });
  const a=action('r3-held-rollback',root,plan);
  assert.equal((await tx.executeDeferred(a)).ok,true);
  const recovered=new WorkspaceEditTransactionProvider({
    allowedRoots:[root],stateDir,windowsPathLeaseExecutable:WINDOWS_PATH_LEASE_EXECUTABLE
  });
  const undone=await recovered.rollbackDeferred(a);
  assert.equal(undone.ok,true);
  assert.equal((undone.output as any).rollbackPerformed,true);
  assert.equal(await fs.readFile(path.join(root,'count.ts'),'utf8'),initial);
  const record=JSON.parse(await readDurableStateText(
    workspaceEditTransactionJournalPath(stateDir,a.id),JOURNAL_OPTIONS
  )) as WorkspaceEditTransactionRecord;
  assert.equal(record.phase,'ROLLED_BACK');
  assert.deepEqual((await fs.readdir(root)).filter(x=>x.includes('.operator-edit-')),[]);
  assert.equal((await recovered.reconcile({action:a})).status,'not_applied');
});

test('R3 held edit refuses finalize and rollback if verifier or another actor changed bytes', async t => {
  const {root,stateDir}=await fixture(t);
  const initial='let safe = 1;\n';
  const file=path.join(root,'safe.ts');
  await fs.writeFile(file,initial);
  const plan=createMultiFileEditPlan({
    files:[{path:'safe.ts',expectedSha256:digest(initial),
      edits:[{start:initial.indexOf('1'),end:initial.indexOf('1')+1,replacement:'2'}]}]
  });
  const tx=new WorkspaceEditTransactionProvider({
    allowedRoots:[root],stateDir,windowsPathLeaseExecutable:WINDOWS_PATH_LEASE_EXECUTABLE
  });
  const a=action('r3-held-conflict',root,plan);
  assert.equal((await tx.executeDeferred(a)).ok,true);
  await fs.writeFile(file,'let safe = 999;\n');
  await assert.rejects(()=>tx.finalizeDeferred(a),(e:any)=>e?.code==='WORKSPACE_EDIT_DEFERRED_UNCERTAIN');
  await assert.rejects(()=>tx.rollbackDeferred(a),(e:any)=>e?.code==='WORKSPACE_EDIT_DEFERRED_UNCERTAIN');
  assert.equal((await tx.reconcile({action:a})).status,'uncertain');
  assert.equal(await fs.readFile(file,'utf8'),'let safe = 999;\n');
  const record=JSON.parse(await readDurableStateText(
    workspaceEditTransactionJournalPath(stateDir,a.id),JOURNAL_OPTIONS
  )) as WorkspaceEditTransactionRecord;
  assert.equal(record.phase,'VERIFICATION_PENDING');
});

test('R3 public transaction execute never honors untrusted deferFinalization input', async t => {
  const {root,stateDir}=await fixture(t);
  const initial='const x = 1;\n';
  await fs.writeFile(path.join(root,'x.ts'),initial);
  const plan=createMultiFileEditPlan({
    files:[{path:'x.ts',expectedSha256:digest(initial),
      edits:[{start:initial.indexOf('1'),end:initial.indexOf('1')+1,replacement:'9'}]}]
  });
  const tx=new WorkspaceEditTransactionProvider({
    allowedRoots:[root],stateDir,windowsPathLeaseExecutable:WINDOWS_PATH_LEASE_EXECUTABLE
  });
  const a={...action('r3-public-unchanged',root,plan),input:{workspaceRoot:root,plan,deferFinalization:true}};
  const result=await tx.execute(a);
  assert.equal(result.ok,true);
  const record=JSON.parse(await readDurableStateText(
    workspaceEditTransactionJournalPath(stateDir,a.id),JOURNAL_OPTIONS
  )) as WorkspaceEditTransactionRecord;
  assert.equal(record.phase,'COMMITTED');
  await assert.rejects(()=>tx.rollbackDeferred(a),(e:any)=>e?.code==='WORKSPACE_EDIT_DEFERRED_PHASE_INVALID');
});



test('R3 a crash during deferred APPLYING cannot turn exact target hashes into verified completion', async t => {
  const {root,stateDir}=await fixture(t);
  const initial='export const state = 1;\n';
  await fs.writeFile(path.join(root,'state.ts'),initial);
  const plan=createMultiFileEditPlan({
    files:[{path:'state.ts',expectedSha256:digest(initial),
      edits:[{start:initial.indexOf('1'),end:initial.indexOf('1')+1,replacement:'2'}]}]
  });
  const a=action('r3-deferred-crash-window',root,plan);
  const provider=new WorkspaceEditTransactionProvider({
    allowedRoots:[root],stateDir,windowsPathLeaseExecutable:WINDOWS_PATH_LEASE_EXECUTABLE
  });
  assert.equal((await provider.executeDeferred(a)).ok,true);
  const journalPath=workspaceEditTransactionJournalPath(stateDir,a.id);
  const record=JSON.parse(await readDurableStateText(journalPath,JOURNAL_OPTIONS)) as WorkspaceEditTransactionRecord;
  assert.equal(record.requiresVerification,true);
  // Simulate power loss after all renames but before writing final HELD phase.
  const crashed={...record,phase:'APPLYING'};
  await writeDurableStateText(journalPath,JSON.stringify(crashed),JOURNAL_OPTIONS);
  const restarted=new WorkspaceEditTransactionProvider({
    allowedRoots:[root],stateDir,windowsPathLeaseExecutable:WINDOWS_PATH_LEASE_EXECUTABLE
  });
  assert.equal((await restarted.reconcile({action:a})).status,'uncertain');
  const unchanged=JSON.parse(await readDurableStateText(journalPath,JOURNAL_OPTIONS)) as WorkspaceEditTransactionRecord;
  assert.equal(unchanged.phase,'APPLYING');
  assert.equal(unchanged.requiresVerification,true);
  assert.equal(await fs.readFile(path.join(root,'state.ts'),'utf8'),'export const state = 2;\n');
  assert.equal((await fs.stat(record.files[0]!.backupPath)).isFile(),true);
  await assert.rejects(()=>restarted.finalizeDeferred(a),
    (e:any)=>e?.code==='WORKSPACE_EDIT_DEFERRED_PHASE_INVALID');
});

test('R3 rejects forged pending-verifier records without durable pre-dispatch verification fence', async t => {
  const {root,stateDir}=await fixture(t);
  const initial='let hidden = 1;\n';
  await fs.writeFile(path.join(root,'hidden.ts'),initial);
  const plan=createMultiFileEditPlan({
    files:[{path:'hidden.ts',expectedSha256:digest(initial),
      edits:[{start:initial.indexOf('1'),end:initial.indexOf('1')+1,replacement:'2'}]}]
  });
  const a=action('r3-deferred-missing-fence',root,plan);
  const tx=new WorkspaceEditTransactionProvider({
    allowedRoots:[root],stateDir,windowsPathLeaseExecutable:WINDOWS_PATH_LEASE_EXECUTABLE
  });
  assert.equal((await tx.executeDeferred(a)).ok,true);
  const file=workspaceEditTransactionJournalPath(stateDir,a.id);
  const record=JSON.parse(await readDurableStateText(file,JOURNAL_OPTIONS)) as WorkspaceEditTransactionRecord;
  delete record.requiresVerification;
  await writeDurableStateText(file,JSON.stringify(record),JOURNAL_OPTIONS);
  await assert.rejects(()=>tx.finalizeDeferred(a),
    (e:any)=>e?.code==='WORKSPACE_EDIT_TRANSACTION_CORRUPT');
  assert.equal((await tx.reconcile({action:a})).status,'uncertain');
});


test('C06/C08 distinct provider instances serialize competing edits under one durable-state coordinator', async t => {
  const { root, stateDir } = await fixture(t);
  const before = 'const serial = 1;\n';
  const target = path.join(root, 'serial.ts');
  await fs.writeFile(target, before);
  const providers = [0, 1].map(() => new WorkspaceEditTransactionProvider({
    allowedRoots: [root], stateDir, windowsPathLeaseExecutable: WINDOWS_PATH_LEASE_EXECUTABLE
  }));
  const edit = (value: string) => createMultiFileEditPlan({ files: [{
    path: 'serial.ts', expectedSha256: digest(before),
    edits: [{ start: before.indexOf('1'), end: before.indexOf('1') + 1, replacement: value }]
  }] });
  const results = await Promise.all([
    providers[0]!.execute(action('concurrent-a', root, edit('2'))),
    providers[1]!.execute(action('concurrent-b', root, edit('3')))
  ]);
  assert.equal(results.filter(result => result.ok).length, 1,
    'exactly one competing edit may consume the original file generation');
  const denied = results.find(result => !result.ok)!;
  assert.equal(denied.error?.sideEffectState, 'none', 'loser must be refused before mutation');
  const winningValue = results[0]!.ok ? '2' : '3';
  assert.equal(await fs.readFile(target, 'utf8'), 'const serial = ' + winningValue + ';\n');
  assert.deepEqual((await fs.readdir(root)).filter(name => name.includes('.operator-edit-')), []);
});

test('C06/C08 a held coordinator lock fences editing before its first journal write', async t => {
  const { root, stateDir } = await fixture(t);
  const initial = 'const guarded = 1;\n';
  const target = path.join(root, 'guarded.ts');
  await fs.writeFile(target, initial);
  const plan = createMultiFileEditPlan({ files: [{
    path: 'guarded.ts', expectedSha256: digest(initial),
    edits: [{ start: initial.indexOf('1'), end: initial.indexOf('1') + 1, replacement: '2' }]
  }] });
  const a = action('locked-edit', root, plan);
  const provider = new WorkspaceEditTransactionProvider({
    allowedRoots: [root], stateDir, windowsPathLeaseExecutable: WINDOWS_PATH_LEASE_EXECUTABLE
  });
  let release!: () => void;
  let acquired!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { acquired = resolve; });
  const owner = withDurableStateLock(workspaceEditTransactionCoordinatorPath(stateDir), async () => {
    acquired();
    await gate;
  });
  await entered;
  const pending = provider.execute(a);
  try {
    const settledEarly = await Promise.race([
      pending.then(() => true),
      new Promise<false>(resolve => setTimeout(() => resolve(false), 75))
    ]);
    assert.equal(settledEarly, false, 'an independently owned lock must block edits');
    await assert.rejects(fs.access(workspaceEditTransactionJournalPath(stateDir, a.id)));
    assert.equal(await fs.readFile(target, 'utf8'), initial);
  } finally {
    release();
    await owner;
  }
  const result = await pending;
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(await fs.readFile(target, 'utf8'), 'const guarded = 2;\n');
});
