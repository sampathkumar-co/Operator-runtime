import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  ActionRequest,
  ActionResult,
  CapabilityExecutionContext,
  CapabilityProvider,
  CapabilityScore,
  ProviderReconciliationRequest,
  ProviderReconciliationResult
} from '../core/types.ts';
import { evidence } from '../core/evidence.ts';
import { OperatorError } from '../core/errors.ts';
import { readDurableStateText, writeDurableStateText } from '../core/durable-state.ts';
import {
  applyMultiFileEditPlan,
  validateMultiFileEditPlan,
  type MultiFileEditPlan
} from '../core/multi-file-edit-plan.ts';
import { PathScope } from './path-scope.ts';

const SCORE: CapabilityScore = {
  reliability: 0.99,
  latency: 0.84,
  determinism: 0.99,
  security: 0.99,
  reversibility: 0.99,
  informationQuality: 0.99,
  interactionCost: 0.03
};

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const STATE_OPTIONS = {
  maxBytes: 4 * 1024 * 1024,
  errorCode: 'WORKSPACE_EDIT_TRANSACTION_CORRUPT',
  invalidMessage: 'Workspace edit transaction journal is invalid.'
} as const;

export type WorkspaceEditTransactionPhase =
  | 'PREPARED'
  | 'APPLYING'
  | 'VERIFICATION_PENDING'
  | 'COMMITTED_CLEANUP'
  | 'COMMITTED'
  | 'ROLLBACK_REQUIRED'
  | 'ROLLED_BACK';

export interface WorkspaceEditTransactionFileRecord {
  path: string;
  targetPath: string;
  tempPath: string;
  backupPath: string;
  discardPath: string;
  beforeSha256: string;
  afterSha256: string;
  mode: number;
}

export interface WorkspaceEditTransactionRecord {
  schemaVersion: 1;
  actionId: string;
  workspaceRoot: string;
  planId: string;
  phase: WorkspaceEditTransactionPhase;
  files: WorkspaceEditTransactionFileRecord[];
  createdAt: string;
  updatedAt: string;
}

type PathState =
  | { kind: 'missing' }
  | { kind: 'regular'; sha256: string; mode: number }
  | { kind: 'unsafe' };

export class WorkspaceEditTransactionProvider implements CapabilityProvider {
  readonly name = 'workspace.edit.transaction';
  #scope: PathScope;
  #stateDir: string;
  #clock: () => Date;
  #serial: Promise<void> = Promise.resolve();

  constructor(options: {
    allowedRoots: string[];
    stateDir: string;
    windowsPathLeaseExecutable?: string;
    clock?: () => Date;
  }) {
    if (!options.stateDir) throw new OperatorError('WORKSPACE_EDIT_STATE_DIR_REQUIRED', 'stateDir is required.');
    this.#scope = new PathScope(options.allowedRoots, {
      windowsPathLeaseExecutable: options.windowsPathLeaseExecutable
    });
    this.#stateDir = path.resolve(options.stateDir);
    this.#clock = options.clock ?? (() => new Date());
  }

  supports(action: ActionRequest): boolean {
    return action.capability === 'workspace.edit.transaction';
  }

  score(): CapabilityScore {
    return SCORE;
  }

  async execute(action: ActionRequest, context: CapabilityExecutionContext = {}): Promise<ActionResult> {
    return await this.#enqueue(async () => await this.#executeSerial(action, context));
  }

  async reconcile(
    request: ProviderReconciliationRequest,
    _context: CapabilityExecutionContext = {}
  ): Promise<ProviderReconciliationResult> {
    return await this.#enqueue(async () => await this.#reconcileSerial(request.action));
  }

  async finalizeDeferred(action: ActionRequest): Promise<ActionResult> {
    return await this.#enqueue(async () => {
      const started = performance.now();
      const parsed = parseAction(action);
      const workspaceRoot = await this.#resolveWorkspaceRoot(parsed.workspaceRootInput);
      const record = await this.#readRecord(action.id);
      if (!record) {
        return transactionControlFailure(action, 'WORKSPACE_EDIT_TRANSACTION_MISSING', 'Deferred transaction journal is missing.', started, 'none');
      }
      assertRecordMatchesAction(record, workspaceRoot, parsed.plan);
      if (record.phase === 'COMMITTED') return successResult(action, record, started, true, false);
      if (record.phase !== 'VERIFICATION_PENDING') {
        return transactionControlFailure(
          action,
          'WORKSPACE_EDIT_FINALIZE_STATE_INVALID',
          'Deferred transaction is not pending verification.',
          started,
          'uncertain'
        );
      }
      try {
        const cleanup = { ...record, phase: 'COMMITTED_CLEANUP' as const, updatedAt: this.#now() };
        await this.#writeRecord(cleanup);
        await this.#cleanupCommitted(cleanup);
        const committed = { ...cleanup, phase: 'COMMITTED' as const, updatedAt: this.#now() };
        await this.#writeRecord(committed);
        return successResult(action, committed, started, false, false);
      } catch (error) {
        const op = asOperatorError(error, 'WORKSPACE_EDIT_FINALIZE_FAILED');
        return transactionControlFailure(action, op.code, op.message, started, 'uncertain');
      }
    });
  }

  async rollbackDeferred(action: ActionRequest): Promise<ActionResult> {
    return await this.#enqueue(async () => {
      const started = performance.now();
      const parsed = parseAction(action);
      const workspaceRoot = await this.#resolveWorkspaceRoot(parsed.workspaceRootInput);
      const record = await this.#readRecord(action.id);
      if (!record) {
        return transactionControlFailure(action, 'WORKSPACE_EDIT_TRANSACTION_MISSING', 'Deferred transaction journal is missing.', started, 'none');
      }
      assertRecordMatchesAction(record, workspaceRoot, parsed.plan);
      if (record.phase === 'ROLLED_BACK') {
        return rollbackControlSuccess(action, record, started, true);
      }
      if (record.phase !== 'VERIFICATION_PENDING' && record.phase !== 'ROLLBACK_REQUIRED') {
        return transactionControlFailure(
          action,
          'WORKSPACE_EDIT_ROLLBACK_STATE_INVALID',
          'Deferred transaction is not safely rollbackable from its current phase.',
          started,
          'uncertain'
        );
      }
      try {
        const rollbackRequired = { ...record, phase: 'ROLLBACK_REQUIRED' as const, updatedAt: this.#now() };
        await this.#writeRecord(rollbackRequired);
        await this.#rollback(rollbackRequired);
        const rolledBack = { ...rollbackRequired, phase: 'ROLLED_BACK' as const, updatedAt: this.#now() };
        await this.#writeRecord(rolledBack);
        return rollbackControlSuccess(action, rolledBack, started, false);
      } catch (error) {
        const op = asOperatorError(error, 'WORKSPACE_EDIT_ROLLBACK_FAILED');
        return transactionControlFailure(action, op.code, op.message, started, 'uncertain');
      }
    });
  }

  async #executeSerial(action: ActionRequest, context: CapabilityExecutionContext): Promise<ActionResult> {
    const started = performance.now();
    try {
      if (action.risk !== 'write') {
        throw new OperatorError('WORKSPACE_EDIT_RISK_MISMATCH', 'workspace.edit.transaction requires write risk.');
      }
      if (context.signal?.aborted) throw new OperatorError('EXECUTION_ABORTED', 'Workspace edit was cancelled.');

      const parsed = parseAction(action);
      const deferFinalization = action.input.deferFinalization === true;
      if (deferFinalization && action.provenance.kind !== 'trusted_policy' && action.provenance.kind !== 'runtime') {
        throw new OperatorError(
          'WORKSPACE_EDIT_DEFERRED_FINALIZATION_DENIED',
          'Deferred finalization is reserved for trusted runtime verification orchestration.'
        );
      }
      const workspaceRoot = await this.#resolveWorkspaceRoot(parsed.workspaceRootInput);
      const existing = await this.#readRecord(action.id);
      if (existing) {
        assertRecordMatchesAction(existing, workspaceRoot, parsed.plan);
        const reconciled = await this.#reconcileRecord(action, existing);
        if (reconciled.status === 'completed' && reconciled.result) return reconciled.result;
        if (reconciled.status === 'not_applied') {
          throw new OperatorError(
            'WORKSPACE_EDIT_PREVIOUS_ATTEMPT_ROLLED_BACK',
            'This action id already owns a rolled-back transaction. Use a new action id to retry.'
          );
        }
        throw new OperatorError(
          'WORKSPACE_EDIT_RECONCILIATION_REQUIRED',
          'Existing workspace edit transaction is ambiguous and must be reconciled before retry.'
        );
      }

      const prepared = await this.#stage(
        action,
        parsed.workspaceRootInput,
        workspaceRoot,
        parsed.plan,
        context
      );
      await this.#writeRecord(prepared);

      const applying = { ...prepared, phase: 'APPLYING' as const, updatedAt: this.#now() };
      await this.#writeRecord(applying);

      try {
        for (const file of applying.files) {
          if (context.signal?.aborted) throw new OperatorError('EXECUTION_ABORTED', 'Workspace edit was cancelled during apply.');
          await this.#applyOne(file);
        }
        if (deferFinalization) {
          const pending = { ...applying, phase: 'VERIFICATION_PENDING' as const, updatedAt: this.#now() };
          await this.#writeRecord(pending);
          return successResult(action, pending, started, false, true);
        }
        const cleanup = { ...applying, phase: 'COMMITTED_CLEANUP' as const, updatedAt: this.#now() };
        await this.#writeRecord(cleanup);
        await this.#cleanupCommitted(cleanup);
        const committed = { ...cleanup, phase: 'COMMITTED' as const, updatedAt: this.#now() };
        await this.#writeRecord(committed);
        return successResult(action, committed, started, false, false);
      } catch (error) {
        const rollbackRequired = { ...applying, phase: 'ROLLBACK_REQUIRED' as const, updatedAt: this.#now() };
        await this.#writeRecord(rollbackRequired);
        try {
          await this.#rollback(rollbackRequired);
          const rolledBack = { ...rollbackRequired, phase: 'ROLLED_BACK' as const, updatedAt: this.#now() };
          await this.#writeRecord(rolledBack);
          const op = asOperatorError(error, 'WORKSPACE_EDIT_APPLY_FAILED');
          return {
            ok: false,
            capability: action.capability,
            provider: this.name,
            output: { planId: parsed.plan.id, workspaceRoot, rollbackPerformed: true },
            evidence: [
              evidence('workspace_edit_transaction', 'fail', op.message, { code: op.code, planId: parsed.plan.id }),
              evidence('workspace_edit_rollback', 'pass', 'All transaction targets were restored to their exact pre-edit hashes.', {
                planId: parsed.plan.id
              })
            ],
            error: {
              code: 'WORKSPACE_EDIT_FAILED_ROLLED_BACK',
              message: op.message,
              retryable: false,
              sideEffectState: 'none',
              executionPhase: 'effect_observed'
            },
            durationMs: Math.round(performance.now() - started)
          };
        } catch (rollbackError) {
          const op = asOperatorError(error, 'WORKSPACE_EDIT_APPLY_FAILED');
          const rb = asOperatorError(rollbackError, 'WORKSPACE_EDIT_ROLLBACK_FAILED');
          return {
            ok: false,
            capability: action.capability,
            provider: this.name,
            output: { planId: parsed.plan.id, workspaceRoot, rollbackPerformed: false },
            evidence: [
              evidence('workspace_edit_transaction', 'fail', op.message, { code: op.code, planId: parsed.plan.id }),
              evidence('workspace_edit_rollback', 'fail', rb.message, { code: rb.code, planId: parsed.plan.id })
            ],
            error: {
              code: 'WORKSPACE_EDIT_FAILED_ROLLBACK_UNCERTAIN',
              message: 'Workspace edit failed and exact rollback could not be proven.',
              retryable: false,
              sideEffectState: 'uncertain',
              executionPhase: 'effect_observed',
              details: { applyCode: op.code, rollbackCode: rb.code }
            },
            durationMs: Math.round(performance.now() - started)
          };
        }
      }
    } catch (error) {
      const op = asOperatorError(error, 'WORKSPACE_EDIT_TRANSACTION_ERROR');
      return {
        ok: false,
        capability: action.capability,
        provider: this.name,
        evidence: [evidence('workspace_edit_transaction', 'fail', op.message, { code: op.code })],
        error: {
          code: op.code,
          message: op.message,
          retryable: op.retryable,
          sideEffectState: op.code === 'WORKSPACE_EDIT_RECONCILIATION_REQUIRED' ? 'uncertain' : 'none',
          executionPhase: 'pre_dispatch'
        },
        durationMs: Math.round(performance.now() - started)
      };
    }
  }

  async #reconcileSerial(action: ActionRequest): Promise<ProviderReconciliationResult> {
    try {
      const parsed = parseAction(action);
      const workspaceRoot = await this.#resolveWorkspaceRoot(parsed.workspaceRootInput);
      const record = await this.#readRecord(action.id);
      if (!record) {
        return {
          status: 'not_applied',
          evidence: [evidence(
            'workspace_edit_reconciliation',
            'info',
            'No durable transaction journal exists; this provider journals before its first mutation.'
          )]
        };
      }
      assertRecordMatchesAction(record, workspaceRoot, parsed.plan);
      return await this.#reconcileRecord(action, record);
    } catch (error) {
      const op = asOperatorError(error, 'WORKSPACE_EDIT_RECONCILIATION_FAILED');
      return {
        status: 'uncertain',
        evidence: [evidence('workspace_edit_reconciliation', 'info', 'Workspace edit state could not be reconciled safely.', {
          code: op.code
        })]
      };
    }
  }

  async #reconcileRecord(
    action: ActionRequest,
    recordInput: WorkspaceEditTransactionRecord
  ): Promise<ProviderReconciliationResult> {
    const record = validateRecord(recordInput);
    const states = await Promise.all(record.files.map(async (file) => ({
      file,
      target: await inspectPath(file.targetPath),
      temp: await inspectPath(file.tempPath),
      backup: await inspectPath(file.backupPath),
      discard: await inspectPath(file.discardPath)
    })));

    if (states.some((item) =>
      item.target.kind === 'unsafe' ||
      item.temp.kind === 'unsafe' ||
      item.backup.kind === 'unsafe' ||
      item.discard.kind === 'unsafe'
    )) {
      return {
        status: 'uncertain',
        evidence: [evidence(
          'workspace_edit_reconciliation',
          'info',
          'A transaction path has unsafe link/type topology; no automatic mutation was attempted.',
          { planId: record.planId }
        )]
      };
    }

    const allAfter = states.every((item) =>
      item.target.kind === 'regular' && item.target.sha256 === item.file.afterSha256
    );
    if (allAfter && record.phase === 'VERIFICATION_PENDING') {
      return {
        status: 'completed',
        result: successResult(action, record, 0, true, true),
        evidence: [evidence(
          'workspace_edit_reconciliation',
          'pass',
          'Every target exactly matches the planned post-edit hash and remains held for verification.',
          { planId: record.planId }
        )]
      };
    }

    if (allAfter) {
      const cleanup = { ...record, phase: 'COMMITTED_CLEANUP' as const, updatedAt: this.#now() };
      await this.#writeRecord(cleanup);
      await this.#cleanupCommitted(cleanup);
      const committed = { ...cleanup, phase: 'COMMITTED' as const, updatedAt: this.#now() };
      await this.#writeRecord(committed);
      return {
        status: 'completed',
        result: successResult(action, committed, 0, true, false),
        evidence: [evidence(
          'workspace_edit_reconciliation',
          'pass',
          'Every target exactly matches the planned post-edit hash.',
          { planId: record.planId }
        )]
      };
    }

    const allBefore = states.every((item) =>
      item.target.kind === 'regular' && item.target.sha256 === item.file.beforeSha256
    );
    if (allBefore) {
      await this.#cleanupRolledBack(record);
      const rolledBack = { ...record, phase: 'ROLLED_BACK' as const, updatedAt: this.#now() };
      await this.#writeRecord(rolledBack);
      return {
        status: 'not_applied',
        evidence: [evidence(
          'workspace_edit_reconciliation',
          'pass',
          'Every target exactly matches its pre-edit hash.',
          { planId: record.planId }
        )]
      };
    }

    try {
      const rollbackRequired = { ...record, phase: 'ROLLBACK_REQUIRED' as const, updatedAt: this.#now() };
      await this.#writeRecord(rollbackRequired);
      await this.#rollback(rollbackRequired);
      const rolledBack = { ...rollbackRequired, phase: 'ROLLED_BACK' as const, updatedAt: this.#now() };
      await this.#writeRecord(rolledBack);
      return {
        status: 'not_applied',
        evidence: [evidence(
          'workspace_edit_reconciliation',
          'pass',
          'A partial transaction was recovered to exact pre-edit hashes.',
          { planId: record.planId }
        )]
      };
    } catch (error) {
      const op = asOperatorError(error, 'WORKSPACE_EDIT_RECONCILIATION_ROLLBACK_FAILED');
      return {
        status: 'uncertain',
        evidence: [evidence(
          'workspace_edit_reconciliation',
          'info',
          'Partial state could not be rolled back without overwriting unknown bytes.',
          { planId: record.planId, code: op.code }
        )]
      };
    }
  }

  async #stage(
    action: ActionRequest,
    workspaceRootInput: string,
    workspaceRoot: string,
    plan: MultiFileEditPlan,
    context: CapabilityExecutionContext
  ): Promise<WorkspaceEditTransactionRecord> {
    const currentContent: Record<string, string> = {};
    const metadata = new Map<string, { targetPath: string; mode: number }>();

    for (const file of plan.files) {
      if (context.signal?.aborted) throw new OperatorError('EXECUTION_ABORTED', 'Workspace edit was cancelled during staging.');
      const targetInput = path.join(workspaceRootInput, ...file.path.split('/'));
      await this.#scope.withExisting(targetInput, async (targetPath) => {
        const stat = await fs.lstat(targetPath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
          throw new OperatorError('WORKSPACE_EDIT_TARGET_UNSAFE', 'Edit target must be a singly linked regular file.', {
            details: { path: file.path }
          });
        }
        if (stat.size > MAX_FILE_BYTES) {
          throw new OperatorError('WORKSPACE_EDIT_TARGET_TOO_LARGE', 'Edit target exceeds the file byte limit.');
        }
        const bytes = await fs.readFile(targetPath);
        const text = bytes.toString('utf8');
        if (!Buffer.from(text, 'utf8').equals(bytes)) {
          throw new OperatorError('WORKSPACE_EDIT_TARGET_NON_UTF8', 'Edit target must be valid UTF-8.');
        }
        currentContent[file.path] = text;
        metadata.set(file.path, { targetPath, mode: stat.mode & 0o777 });
      });
    }

    const applied = applyMultiFileEditPlan(plan, currentContent);
    const token = crypto.createHash('sha256')
      .update(action.id + '\0' + plan.id + '\0' + workspaceRoot, 'utf8')
      .digest('hex')
      .slice(0, 20);
    const files: WorkspaceEditTransactionFileRecord[] = [];
    const staged: string[] = [];

    try {
      for (const file of plan.files) {
        const meta = metadata.get(file.path)!;
        const dir = path.dirname(meta.targetPath);
        const base = path.basename(meta.targetPath);
        const suffix = token + '-' + crypto.randomUUID();
        const tempPath = path.join(dir, '.' + base + '.operator-edit-' + suffix + '.tmp');
        const backupPath = path.join(dir, '.' + base + '.operator-edit-' + suffix + '.bak');
        const discardPath = path.join(dir, '.' + base + '.operator-edit-' + suffix + '.discard');
        const next = applied.contentByPath[file.path]!;
        const handle = await fs.open(tempPath, 'wx', meta.mode || 0o600);
        try {
          await handle.writeFile(next, 'utf8');
          await handle.sync();
        } finally {
          await handle.close();
        }
        if (process.platform !== 'win32') await syncDirectory(dir);
        const afterSha256 = sha256(Buffer.from(next, 'utf8'));
        const stagedState = await inspectPath(tempPath);
        if (stagedState.kind !== 'regular' || stagedState.sha256 !== afterSha256) {
          throw new OperatorError('WORKSPACE_EDIT_STAGE_VERIFY_FAILED', 'Staged edit bytes failed verification.');
        }
        staged.push(tempPath);
        files.push({
          path: file.path,
          targetPath: meta.targetPath,
          tempPath,
          backupPath,
          discardPath,
          beforeSha256: file.expectedSha256,
          afterSha256,
          mode: meta.mode
        });
      }
    } catch (error) {
      for (const file of staged) await fs.rm(file, { force: true }).catch(() => undefined);
      throw error;
    }

    const now = this.#now();
    return validateRecord({
      schemaVersion: 1,
      actionId: action.id,
      workspaceRoot,
      planId: plan.id,
      phase: 'PREPARED',
      files,
      createdAt: now,
      updatedAt: now
    });
  }

  async #applyOne(file: WorkspaceEditTransactionFileRecord): Promise<void> {
    const target = await inspectPath(file.targetPath);
    const temp = await inspectPath(file.tempPath);
    if (target.kind !== 'regular' || target.sha256 !== file.beforeSha256) {
      throw new OperatorError('WORKSPACE_EDIT_PRECONDITION_CHANGED', 'Target changed after staging.', {
        details: { path: file.path }
      });
    }
    if (temp.kind !== 'regular' || temp.sha256 !== file.afterSha256) {
      throw new OperatorError('WORKSPACE_EDIT_STAGE_CHANGED', 'Staged bytes changed before apply.');
    }
    if ((await inspectPath(file.backupPath)).kind !== 'missing') {
      throw new OperatorError('WORKSPACE_EDIT_BACKUP_COLLISION', 'Backup path already exists.');
    }
    if ((await inspectPath(file.discardPath)).kind !== 'missing') {
      throw new OperatorError('WORKSPACE_EDIT_DISCARD_COLLISION', 'Discard path already exists.');
    }

    await fs.rename(file.targetPath, file.backupPath);
    if (process.platform !== 'win32') await syncDirectory(path.dirname(file.targetPath));
    const backup = await inspectPath(file.backupPath);
    if (backup.kind !== 'regular' || backup.sha256 !== file.beforeSha256) {
      throw new OperatorError('WORKSPACE_EDIT_BACKUP_VERIFY_FAILED', 'Backup does not match pre-edit bytes.');
    }

    await fs.rename(file.tempPath, file.targetPath);
    if (process.platform !== 'win32') await syncDirectory(path.dirname(file.targetPath));
    const committed = await inspectPath(file.targetPath);
    if (committed.kind !== 'regular' || committed.sha256 !== file.afterSha256) {
      throw new OperatorError('WORKSPACE_EDIT_APPLY_VERIFY_FAILED', 'Applied bytes do not match staged bytes.');
    }
  }

  async #rollback(record: WorkspaceEditTransactionRecord): Promise<void> {
    for (const file of [...record.files].reverse()) await this.#rollbackOne(file);
    for (const file of record.files) {
      const target = await inspectPath(file.targetPath);
      if (target.kind !== 'regular' || target.sha256 !== file.beforeSha256) {
        throw new OperatorError('WORKSPACE_EDIT_ROLLBACK_VERIFY_FAILED', 'Rollback did not restore exact pre-edit bytes.', {
          details: { path: file.path }
        });
      }
    }
    await this.#cleanupRolledBack(record);
  }

  async #rollbackOne(file: WorkspaceEditTransactionFileRecord): Promise<void> {
    let target = await inspectPath(file.targetPath);
    const backup = await inspectPath(file.backupPath);
    const temp = await inspectPath(file.tempPath);
    const discard = await inspectPath(file.discardPath);

    if (target.kind === 'unsafe' || backup.kind === 'unsafe' || temp.kind === 'unsafe' || discard.kind === 'unsafe') {
      throw new OperatorError('WORKSPACE_EDIT_ROLLBACK_UNSAFE', 'Rollback encountered unsafe path topology.');
    }
    if (target.kind === 'regular' && target.sha256 === file.beforeSha256) return;
    if (target.kind === 'regular' && target.sha256 !== file.afterSha256) {
      throw new OperatorError('WORKSPACE_EDIT_ROLLBACK_AMBIGUOUS', 'Target matches neither pre-edit nor post-edit bytes.');
    }
    if (backup.kind !== 'regular' || backup.sha256 !== file.beforeSha256) {
      throw new OperatorError('WORKSPACE_EDIT_ROLLBACK_BACKUP_INVALID', 'Verified pre-edit backup is unavailable.');
    }

    if (target.kind === 'regular') {
      if (discard.kind !== 'missing') {
        throw new OperatorError('WORKSPACE_EDIT_ROLLBACK_DISCARD_COLLISION', 'Rollback discard path already exists.');
      }
      await fs.rename(file.targetPath, file.discardPath);
      if (process.platform !== 'win32') await syncDirectory(path.dirname(file.targetPath));
      const claimed = await inspectPath(file.discardPath);
      if (claimed.kind !== 'regular' || claimed.sha256 !== file.afterSha256) {
        throw new OperatorError('WORKSPACE_EDIT_ROLLBACK_DISCARD_VERIFY_FAILED', 'Could not safely claim post-edit bytes.');
      }
      target = { kind: 'missing' };
    }

    if (target.kind === 'missing') {
      await fs.rename(file.backupPath, file.targetPath);
      if (process.platform !== 'win32') await syncDirectory(path.dirname(file.targetPath));
    }
    const restored = await inspectPath(file.targetPath);
    if (restored.kind !== 'regular' || restored.sha256 !== file.beforeSha256) {
      throw new OperatorError('WORKSPACE_EDIT_ROLLBACK_VERIFY_FAILED', 'Restored target hash is incorrect.');
    }
    await removeIfExact(file.discardPath, file.afterSha256);
  }

  async #cleanupCommitted(record: WorkspaceEditTransactionRecord): Promise<void> {
    for (const file of record.files) {
      const target = await inspectPath(file.targetPath);
      if (target.kind !== 'regular' || target.sha256 !== file.afterSha256) {
        throw new OperatorError('WORKSPACE_EDIT_COMMIT_VERIFY_FAILED', 'Committed target changed before cleanup.');
      }
      await removeIfExact(file.backupPath, file.beforeSha256);
      await removeIfExact(file.tempPath, file.afterSha256);
      await removeIfExact(file.discardPath, file.afterSha256);
    }
  }

  async #cleanupRolledBack(record: WorkspaceEditTransactionRecord): Promise<void> {
    for (const file of record.files) {
      const target = await inspectPath(file.targetPath);
      if (target.kind !== 'regular' || target.sha256 !== file.beforeSha256) {
        throw new OperatorError('WORKSPACE_EDIT_ROLLBACK_VERIFY_FAILED', 'Target is not restored before cleanup.');
      }
      await removeIfExact(file.tempPath, file.afterSha256);
      await removeIfExact(file.backupPath, file.beforeSha256);
      await removeIfExact(file.discardPath, file.afterSha256);
    }
  }

  async #resolveWorkspaceRoot(input: string): Promise<string> {
    return await this.#scope.withExisting(input, async (resolved) => {
      const stat = await fs.lstat(resolved);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new OperatorError('WORKSPACE_EDIT_ROOT_INVALID', 'workspaceRoot must resolve to a real directory.');
      }
      return resolved;
    });
  }

  async #readRecord(actionId: string): Promise<WorkspaceEditTransactionRecord | undefined> {
    const file = workspaceEditTransactionJournalPath(this.#stateDir, actionId);
    try {
      return validateRecord(JSON.parse(await readDurableStateText(file, STATE_OPTIONS)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      if (error instanceof SyntaxError) {
        throw new OperatorError('WORKSPACE_EDIT_TRANSACTION_CORRUPT', 'Transaction journal contains invalid JSON.');
      }
      throw error;
    }
  }

  async #writeRecord(record: WorkspaceEditTransactionRecord): Promise<void> {
    const valid = validateRecord(record);
    await writeDurableStateText(
      workspaceEditTransactionJournalPath(this.#stateDir, valid.actionId),
      JSON.stringify(valid),
      STATE_OPTIONS
    );
  }

  #now(): string {
    return this.#clock().toISOString();
  }

  async #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#serial;
    let release!: () => void;
    this.#serial = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export function workspaceEditTransactionJournalPath(stateDir: string, actionId: string): string {
  if (!actionId || Buffer.byteLength(actionId, 'utf8') > 1024 || actionId.includes('\0')) {
    throw new OperatorError('WORKSPACE_EDIT_ACTION_ID_INVALID', 'Workspace edit action id is invalid.');
  }
  const digestValue = crypto.createHash('sha256').update(actionId, 'utf8').digest('hex');
  return path.join(path.resolve(stateDir), 'workspace-edit-transactions', digestValue + '.json');
}

function parseAction(action: ActionRequest): { workspaceRootInput: string; plan: MultiFileEditPlan } {
  const workspaceRootInput = String(action.input.workspaceRoot ?? '');
  if (!workspaceRootInput || workspaceRootInput.includes('\0')) {
    throw new OperatorError('WORKSPACE_EDIT_ROOT_REQUIRED', 'workspaceRoot is required.');
  }
  return {
    workspaceRootInput,
    plan: validateMultiFileEditPlan(action.input.plan as MultiFileEditPlan)
  };
}

function assertRecordMatchesAction(
  record: WorkspaceEditTransactionRecord,
  resolvedWorkspaceRoot: string,
  plan: MultiFileEditPlan
): void {
  if (record.planId !== plan.id) {
    throw new OperatorError('WORKSPACE_EDIT_ACTION_REUSE_INVALID', 'Action id is bound to a different edit plan.');
  }
  const requested = canonicalPath(resolvedWorkspaceRoot);
  const recorded = canonicalPath(record.workspaceRoot);
  if (requested !== recorded) {
    throw new OperatorError('WORKSPACE_EDIT_ACTION_REUSE_INVALID', 'Action id is bound to a different workspace root.');
  }
}

function validateRecord(input: unknown): WorkspaceEditTransactionRecord {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw corrupt('Transaction record is invalid.');
  const raw = input as Record<string, unknown>;
  if (raw.schemaVersion !== 1) throw corrupt('Unsupported transaction schema.');
  const actionId = boundedString(raw.actionId, 1024, 'actionId');
  const workspaceRoot = absolutePath(raw.workspaceRoot, 'workspaceRoot');
  const planId = digestField(raw.planId, 'planId');
  const phases = new Set<WorkspaceEditTransactionPhase>([
    'PREPARED', 'APPLYING', 'VERIFICATION_PENDING', 'COMMITTED_CLEANUP', 'COMMITTED', 'ROLLBACK_REQUIRED', 'ROLLED_BACK'
  ]);
  if (!phases.has(raw.phase as WorkspaceEditTransactionPhase)) throw corrupt('Transaction phase is invalid.');
  if (!Array.isArray(raw.files) || raw.files.length < 1 || raw.files.length > 1000) throw corrupt('Transaction file list is invalid.');
  const files = raw.files.map((item) => validateFileRecord(item, workspaceRoot));
  if (new Set(files.map((item) => canonicalPath(item.targetPath))).size !== files.length) {
    throw corrupt('Transaction targets are not unique.');
  }
  const createdAt = canonicalIso(raw.createdAt, 'createdAt');
  const updatedAt = canonicalIso(raw.updatedAt, 'updatedAt');
  if (Date.parse(updatedAt) < Date.parse(createdAt)) throw corrupt('updatedAt precedes createdAt.');
  return {
    schemaVersion: 1,
    actionId,
    workspaceRoot,
    planId,
    phase: raw.phase as WorkspaceEditTransactionPhase,
    files,
    createdAt,
    updatedAt
  };
}

function validateFileRecord(input: unknown, workspaceRoot: string): WorkspaceEditTransactionFileRecord {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw corrupt('Transaction file record is invalid.');
  const raw = input as Record<string, unknown>;
  const relativePath = boundedString(raw.path, 4096, 'path');
  if (relativePath.includes('\\') || path.posix.isAbsolute(relativePath) || relativePath === '..' || relativePath.startsWith('../')) {
    throw corrupt('Transaction relative path is invalid.');
  }
  const targetPath = absolutePath(raw.targetPath, 'targetPath');
  const tempPath = absolutePath(raw.tempPath, 'tempPath');
  const backupPath = absolutePath(raw.backupPath, 'backupPath');
  const discardPath = absolutePath(raw.discardPath, 'discardPath');
  for (const candidate of [targetPath, tempPath, backupPath, discardPath]) {
    if (!inside(candidate, workspaceRoot)) throw corrupt('Transaction path escapes workspaceRoot.');
  }
  if (new Set([targetPath, tempPath, backupPath, discardPath].map(canonicalPath)).size !== 4) {
    throw corrupt('Transaction paths must be distinct.');
  }
  const expectedTarget = path.resolve(workspaceRoot, ...relativePath.split('/'));
  if (canonicalPath(expectedTarget) !== canonicalPath(targetPath)) throw corrupt('Target does not match relative path.');
  const mode = Number(raw.mode);
  if (!Number.isSafeInteger(mode) || mode < 0 || mode > 0o7777) throw corrupt('Transaction mode is invalid.');
  return {
    path: relativePath,
    targetPath,
    tempPath,
    backupPath,
    discardPath,
    beforeSha256: digestField(raw.beforeSha256, 'beforeSha256'),
    afterSha256: digestField(raw.afterSha256, 'afterSha256'),
    mode
  };
}

async function inspectPath(file: string): Promise<PathState> {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_FILE_BYTES) return { kind: 'unsafe' };
    return { kind: 'regular', sha256: sha256(await fs.readFile(file)), mode: stat.mode & 0o777 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    throw error;
  }
}

async function removeIfExact(file: string, expectedSha256: string): Promise<void> {
  const state = await inspectPath(file);
  if (state.kind === 'missing') return;
  if (state.kind !== 'regular' || state.sha256 !== expectedSha256) {
    throw new OperatorError('WORKSPACE_EDIT_CLEANUP_AMBIGUOUS', 'Cleanup refused to remove unknown bytes.', {
      details: { file }
    });
  }
  await fs.rm(file);
  if (process.platform !== 'win32') await syncDirectory(path.dirname(file));
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function successResult(
  action: ActionRequest,
  record: WorkspaceEditTransactionRecord,
  started: number,
  reconciled: boolean,
  pendingVerification: boolean
): ActionResult {
  return {
    ok: true,
    capability: action.capability,
    provider: 'workspace.edit.transaction',
    output: {
      planId: record.planId,
      workspaceRoot: record.workspaceRoot,
      files: record.files.map((file) => ({
        path: file.path,
        beforeSha256: file.beforeSha256,
        afterSha256: file.afterSha256
      })),
      reconciled,
      pendingVerification
    },
    evidence: [
      evidence(
        'workspace_edit_transaction',
        'pass',
        reconciled
          ? (pendingVerification
              ? 'Held edit state was re-established from exact target hashes and remains pending verification.'
              : 'Transaction completion was re-established from exact target hashes.')
          : (pendingVerification
              ? 'All targets were staged and applied with exact hash verification; backups remain held pending verification.'
              : 'All targets were staged before mutation and committed with exact hash verification.'),
        { planId: record.planId, fileCount: record.files.length }
      ),
      evidence('postcondition', 'pass', 'Every edited file matches the planned post-edit SHA-256.', {
        planId: record.planId
      })
    ],
    durationMs: started === 0 ? 0 : Math.round(performance.now() - started)
  };
}

function transactionControlFailure(
  action: ActionRequest,
  code: string,
  message: string,
  started: number,
  sideEffectState: 'none' | 'known' | 'uncertain'
): ActionResult {
  return {
    ok: false,
    capability: action.capability,
    provider: 'workspace.edit.transaction',
    evidence: [evidence('workspace_edit_transaction_control', 'fail', message, { code })],
    error: {
      code,
      message,
      retryable: false,
      sideEffectState,
      executionPhase: sideEffectState === 'none' ? 'pre_dispatch' : 'effect_observed'
    },
    durationMs: Math.round(performance.now() - started)
  };
}

function rollbackControlSuccess(
  action: ActionRequest,
  record: WorkspaceEditTransactionRecord,
  started: number,
  reconciled: boolean
): ActionResult {
  return {
    ok: true,
    capability: action.capability,
    provider: 'workspace.edit.transaction',
    output: {
      planId: record.planId,
      workspaceRoot: record.workspaceRoot,
      rollbackPerformed: true,
      reconciled
    },
    evidence: [evidence(
      'workspace_edit_rollback',
      'pass',
      'Deferred workspace edit was restored to exact pre-edit hashes.',
      { planId: record.planId }
    )],
    durationMs: Math.round(performance.now() - started)
  };
}

function absolutePath(input: unknown, label: string): string {
  const value = boundedString(input, 32 * 1024, label);
  if (!path.isAbsolute(value)) throw corrupt(label + ' must be absolute.');
  return path.resolve(value);
}

function boundedString(input: unknown, maxBytes: number, label: string): string {
  if (typeof input !== 'string' || !input || Buffer.byteLength(input, 'utf8') > maxBytes || input.includes('\0')) {
    throw corrupt(label + ' is invalid.');
  }
  return input;
}

function digestField(input: unknown, label: string): string {
  const value = String(input ?? '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(value)) throw corrupt(label + ' must be SHA-256.');
  return value;
}

function canonicalIso(input: unknown, label: string): string {
  const value = String(input ?? '');
  if (!value || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw corrupt(label + ' must be canonical ISO.');
  }
  return value;
}

function inside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function canonicalPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function sha256(bytes: Uint8Array): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function asOperatorError(error: unknown, fallback: string): OperatorError {
  return error instanceof OperatorError
    ? error
    : new OperatorError(fallback, error instanceof Error ? error.message : String(error));
}

function corrupt(message: string): OperatorError {
  return new OperatorError('WORKSPACE_EDIT_TRANSACTION_CORRUPT', message);
}
