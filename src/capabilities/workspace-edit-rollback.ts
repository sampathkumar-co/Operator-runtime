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
import { ArtifactStore } from '../core/artifact-store.ts';
import { readDurableStateText, writeDurableStateText } from '../core/durable-state.ts';
import { evidence } from '../core/evidence.ts';
import { OperatorError } from '../core/errors.ts';
import { PathScope } from './path-scope.ts';

const SCORE: CapabilityScore = {
  reliability: 0.99,
  latency: 0.82,
  determinism: 0.99,
  security: 0.99,
  reversibility: 0.98,
  informationQuality: 0.99,
  interactionCost: 0.04
};

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const STATE_OPTIONS = {
  maxBytes: 4 * 1024 * 1024,
  errorCode: 'WORKSPACE_EDIT_ROLLBACK_CORRUPT',
  invalidMessage: 'Workspace edit rollback journal is invalid.'
} as const;

type RollbackPhase = 'PREPARED' | 'APPLYING' | 'COMMITTED_CLEANUP' | 'COMMITTED';

interface RollbackArtifactFile {
  path: string;
  beforeSha256: string;
  afterSha256: string;
  mode: number;
  beforeText: string;
}

interface RollbackArtifactPayload {
  schemaVersion: 1;
  transactionActionId: string;
  planId: string;
  workspaceRootDigest: string;
  files: RollbackArtifactFile[];
}

interface RollbackFileRecord {
  path: string;
  targetPath: string;
  tempPath: string;
  discardPath: string;
  beforeSha256: string;
  afterSha256: string;
  mode: number;
}

interface RollbackJournal {
  schemaVersion: 1;
  actionId: string;
  rollbackArtifactId: string;
  transactionActionId: string;
  planId: string;
  workspaceRoot: string;
  phase: RollbackPhase;
  files: RollbackFileRecord[];
  createdAt: string;
  updatedAt: string;
}

type PathState =
  | { kind: 'missing' }
  | { kind: 'regular'; sha256: string; mode: number }
  | { kind: 'unsafe' };

export class WorkspaceEditRollbackProvider implements CapabilityProvider {
  readonly name = 'workspace.edit.rollback';
  #scope: PathScope;
  #stateDir: string;
  #artifacts: ArtifactStore;
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
    this.#artifacts = new ArtifactStore(this.#stateDir);
    this.#clock = options.clock ?? (() => new Date());
  }

  supports(action: ActionRequest): boolean {
    return action.capability === 'workspace.edit.rollback';
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
    return await this.#enqueue(async () => {
      try {
        const parsed = await this.#parse(actionInput(request.action));
        const journal = await this.#readJournal(request.action.id);
        if (!journal) {
          return {
            status: 'not_applied',
            evidence: [evidence(
              'workspace_edit_rollback_reconciliation',
              'info',
              'No rollback journal exists; this provider journals before its first workspace mutation.'
            )]
          };
        }
        assertJournalMatches(journal, request.action.id, parsed.workspaceRoot, parsed.artifactId, parsed.payload);
        return await this.#reconcileJournal(request.action, journal);
      } catch (error) {
        const op = asOperatorError(error, 'WORKSPACE_EDIT_ROLLBACK_RECONCILIATION_FAILED');
        return {
          status: 'uncertain',
          evidence: [evidence(
            'workspace_edit_rollback_reconciliation',
            'info',
            'Rollback state could not be reconciled safely.',
            { code: op.code }
          )]
        };
      }
    });
  }

  async #executeSerial(action: ActionRequest, context: CapabilityExecutionContext): Promise<ActionResult> {
    const started = performance.now();
    try {
      if (action.risk !== 'destructive') {
        throw new OperatorError(
          'WORKSPACE_EDIT_ROLLBACK_RISK_MISMATCH',
          'workspace.edit.rollback requires destructive risk.'
        );
      }
      if (context.signal?.aborted) {
        throw new OperatorError('EXECUTION_ABORTED', 'Workspace edit rollback was cancelled.');
      }

      const parsed = await this.#parse(actionInput(action));
      const existing = await this.#readJournal(action.id);
      if (existing) {
        assertJournalMatches(existing, action.id, parsed.workspaceRoot, parsed.artifactId, parsed.payload);
        const reconciled = await this.#reconcileJournal(action, existing);
        if (reconciled.status === 'completed' && reconciled.result) return reconciled.result;
        if (reconciled.status === 'uncertain') {
          throw new OperatorError(
            'WORKSPACE_EDIT_ROLLBACK_RECONCILIATION_REQUIRED',
            'Existing rollback attempt is ambiguous and must be reconciled before retry.'
          );
        }
      }

      const prepared = await this.#prepare(action, parsed.workspaceRoot, parsed.artifactId, parsed.payload, context);
      await this.#writeJournal(prepared);
      const applying = { ...prepared, phase: 'APPLYING' as const, updatedAt: this.#now() };
      await this.#writeJournal(applying);
      await this.#resumeApply(applying, parsed.payload, context);
      const cleanup = { ...applying, phase: 'COMMITTED_CLEANUP' as const, updatedAt: this.#now() };
      await this.#writeJournal(cleanup);
      await this.#cleanup(cleanup);
      const committed = { ...cleanup, phase: 'COMMITTED' as const, updatedAt: this.#now() };
      await this.#writeJournal(committed);
      return success(action, committed, started, false);
    } catch (error) {
      const op = asOperatorError(error, 'WORKSPACE_EDIT_ROLLBACK_FAILED');
      return {
        ok: false,
        capability: action.capability,
        provider: this.name,
        evidence: [evidence('workspace_edit_rollback', 'fail', op.message, { code: op.code })],
        error: {
          code: op.code,
          message: op.message,
          retryable: op.retryable,
          sideEffectState:
            op.code === 'WORKSPACE_EDIT_ROLLBACK_RECONCILIATION_REQUIRED' ||
            op.code === 'WORKSPACE_EDIT_ROLLBACK_AMBIGUOUS'
              ? 'uncertain'
              : 'none',
          executionPhase:
            op.code === 'WORKSPACE_EDIT_ROLLBACK_RECONCILIATION_REQUIRED' ||
            op.code === 'WORKSPACE_EDIT_ROLLBACK_AMBIGUOUS'
              ? 'effect_observed'
              : 'pre_dispatch'
        },
        durationMs: Math.round(performance.now() - started)
      };
    }
  }

  async #parse(input: { workspaceRootInput: string; artifactId: string }): Promise<{
    workspaceRoot: string;
    artifactId: string;
    payload: RollbackArtifactPayload;
  }> {
    const workspaceRoot = await this.#scope.withExisting(input.workspaceRootInput, async (resolved) => {
      const stat = await fs.lstat(resolved);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new OperatorError('WORKSPACE_EDIT_ROOT_INVALID', 'workspaceRoot must resolve to a real directory.');
      }
      return resolved;
    });
    const artifact = await this.#artifacts.read(input.artifactId);
    if (
      artifact.record.kind !== 'patch' ||
      artifact.record.mediaType !== 'application/json' ||
      artifact.record.privacy !== 'sensitive' ||
      artifact.record.metadata.rollbackType !== 'workspace-edit'
    ) {
      throw new OperatorError(
        'WORKSPACE_EDIT_ROLLBACK_ARTIFACT_INVALID',
        'Rollback artifact has the wrong immutable class.'
      );
    }
    let raw: unknown;
    try {
      raw = JSON.parse(artifact.bytes.toString('utf8'));
    } catch {
      throw new OperatorError('WORKSPACE_EDIT_ROLLBACK_ARTIFACT_INVALID', 'Rollback artifact JSON is invalid.');
    }
    const payload = validatePayload(raw);
    if (payload.workspaceRootDigest !== sha256(Buffer.from(canonicalPath(workspaceRoot), 'utf8'))) {
      throw new OperatorError(
        'WORKSPACE_EDIT_ROLLBACK_WORKSPACE_MISMATCH',
        'Rollback artifact belongs to a different workspace root.'
      );
    }
    if (
      artifact.record.metadata.transactionActionId !== payload.transactionActionId ||
      artifact.record.metadata.planId !== payload.planId ||
      artifact.record.metadata.workspaceRootDigest !== payload.workspaceRootDigest ||
      artifact.record.metadata.fileCount !== payload.files.length
    ) {
      throw new OperatorError(
        'WORKSPACE_EDIT_ROLLBACK_ARTIFACT_INVALID',
        'Rollback artifact metadata does not match its immutable payload.'
      );
    }
    return { workspaceRoot, artifactId: artifact.record.id, payload };
  }

  async #prepare(
    action: ActionRequest,
    workspaceRoot: string,
    artifactId: string,
    payload: RollbackArtifactPayload,
    context: CapabilityExecutionContext
  ): Promise<RollbackJournal> {
    const token = sha256(Buffer.from(action.id + '\0' + artifactId + '\0' + workspaceRoot, 'utf8')).slice(0, 20);
    const files: RollbackFileRecord[] = [];
    const staged: string[] = [];

    try {
      for (const source of payload.files) {
        if (context.signal?.aborted) throw new OperatorError('EXECUTION_ABORTED', 'Rollback staging was cancelled.');
        const targetInput = path.join(workspaceRoot, ...source.path.split('/'));
        await this.#scope.withExisting(targetInput, async (targetPath) => {
          const state = await inspectPath(targetPath);
          if (state.kind !== 'regular' || state.sha256 !== source.afterSha256) {
            if (state.kind === 'regular' && state.sha256 === source.beforeSha256) {
              throw new OperatorError(
                'WORKSPACE_EDIT_ROLLBACK_ALREADY_APPLIED_WITHOUT_JOURNAL',
                'Target already matches rollback bytes but no rollback journal proves this provider performed the restoration.'
              );
            }
            throw new OperatorError(
              'WORKSPACE_EDIT_ROLLBACK_STALE',
              'Rollback target no longer matches the exact committed post-edit hash.',
              { details: { path: source.path } }
            );
          }
          const dir = path.dirname(targetPath);
          const base = path.basename(targetPath);
          const suffix = token + '-' + crypto.randomUUID();
          const tempPath = path.join(dir, '.' + base + '.operator-rollback-' + suffix + '.tmp');
          const discardPath = path.join(dir, '.' + base + '.operator-rollback-' + suffix + '.discard');
          const handle = await fs.open(tempPath, 'wx', source.mode || 0o600);
          try {
            await handle.writeFile(source.beforeText, 'utf8');
            await handle.sync();
          } finally {
            await handle.close();
          }
          if (process.platform !== 'win32') await syncDirectory(dir);
          const tempState = await inspectPath(tempPath);
          if (tempState.kind !== 'regular' || tempState.sha256 !== source.beforeSha256) {
            throw new OperatorError(
              'WORKSPACE_EDIT_ROLLBACK_STAGE_VERIFY_FAILED',
              'Rollback staged bytes failed exact hash verification.'
            );
          }
          staged.push(tempPath);
          files.push({
            path: source.path,
            targetPath,
            tempPath,
            discardPath,
            beforeSha256: source.beforeSha256,
            afterSha256: source.afterSha256,
            mode: source.mode
          });
        });
      }
    } catch (error) {
      for (const file of staged) await fs.rm(file, { force: true }).catch(() => undefined);
      throw error;
    }

    const now = this.#now();
    return validateJournal({
      schemaVersion: 1,
      actionId: action.id,
      rollbackArtifactId: artifactId,
      transactionActionId: payload.transactionActionId,
      planId: payload.planId,
      workspaceRoot,
      phase: 'PREPARED',
      files,
      createdAt: now,
      updatedAt: now
    });
  }

  async #resumeApply(
    journal: RollbackJournal,
    payload: RollbackArtifactPayload,
    context: CapabilityExecutionContext
  ): Promise<void> {
    const byPath = new Map(payload.files.map((item) => [item.path, item]));
    for (const file of journal.files) {
      if (context.signal?.aborted) throw new OperatorError('EXECUTION_ABORTED', 'Rollback apply was cancelled.');
      const source = byPath.get(file.path);
      if (!source) throw corrupt('Rollback payload no longer contains a journal target.');
      await this.#resumeOne(file, source.beforeText);
    }
    for (const file of journal.files) {
      const target = await inspectPath(file.targetPath);
      if (target.kind !== 'regular' || target.sha256 !== file.beforeSha256) {
        throw new OperatorError(
          'WORKSPACE_EDIT_ROLLBACK_POSTCONDITION_FAILED',
          'Rollback did not restore every exact pre-edit hash.',
          { details: { path: file.path } }
        );
      }
    }
  }

  async #resumeOne(file: RollbackFileRecord, beforeText: string): Promise<void> {
    let target = await inspectPath(file.targetPath);
    let temp = await inspectPath(file.tempPath);
    let discard = await inspectPath(file.discardPath);
    if (target.kind === 'unsafe' || temp.kind === 'unsafe' || discard.kind === 'unsafe') {
      throw new OperatorError('WORKSPACE_EDIT_ROLLBACK_AMBIGUOUS', 'Rollback encountered unsafe path topology.');
    }

    if (target.kind === 'regular' && target.sha256 === file.beforeSha256) {
      if (temp.kind === 'regular') await removeIfExact(file.tempPath, file.beforeSha256);
      if (discard.kind === 'regular') await removeIfExact(file.discardPath, file.afterSha256);
      return;
    }

    if (target.kind === 'regular' && target.sha256 !== file.afterSha256) {
      throw new OperatorError(
        'WORKSPACE_EDIT_ROLLBACK_AMBIGUOUS',
        'Rollback target matches neither committed nor pre-edit bytes.',
        { details: { path: file.path } }
      );
    }

    if (temp.kind === 'missing') {
      if (target.kind === 'missing' && discard.kind === 'regular' && discard.sha256 === file.afterSha256) {
        const handle = await fs.open(file.tempPath, 'wx', file.mode || 0o600);
        try {
          await handle.writeFile(beforeText, 'utf8');
          await handle.sync();
        } finally {
          await handle.close();
        }
        if (process.platform !== 'win32') await syncDirectory(path.dirname(file.tempPath));
        temp = await inspectPath(file.tempPath);
      } else {
        throw new OperatorError(
          'WORKSPACE_EDIT_ROLLBACK_AMBIGUOUS',
          'Rollback staged pre-edit bytes are unavailable.'
        );
      }
    }
    if (temp.kind !== 'regular' || temp.sha256 !== file.beforeSha256) {
      throw new OperatorError('WORKSPACE_EDIT_ROLLBACK_AMBIGUOUS', 'Rollback staged bytes changed unexpectedly.');
    }

    if (target.kind === 'regular') {
      if (discard.kind !== 'missing') {
        throw new OperatorError('WORKSPACE_EDIT_ROLLBACK_AMBIGUOUS', 'Rollback discard path is unexpectedly occupied.');
      }
      await fs.rename(file.targetPath, file.discardPath);
      if (process.platform !== 'win32') await syncDirectory(path.dirname(file.targetPath));
      discard = await inspectPath(file.discardPath);
      if (discard.kind !== 'regular' || discard.sha256 !== file.afterSha256) {
        throw new OperatorError('WORKSPACE_EDIT_ROLLBACK_AMBIGUOUS', 'Could not safely claim committed bytes.');
      }
      target = { kind: 'missing' };
    }

    if (target.kind === 'missing') {
      await fs.rename(file.tempPath, file.targetPath);
      if (process.platform !== 'win32') await syncDirectory(path.dirname(file.targetPath));
    }
    const restored = await inspectPath(file.targetPath);
    if (restored.kind !== 'regular' || restored.sha256 !== file.beforeSha256) {
      throw new OperatorError('WORKSPACE_EDIT_ROLLBACK_POSTCONDITION_FAILED', 'Restored target hash is incorrect.');
    }
  }

  async #cleanup(journal: RollbackJournal): Promise<void> {
    for (const file of journal.files) {
      const target = await inspectPath(file.targetPath);
      if (target.kind !== 'regular' || target.sha256 !== file.beforeSha256) {
        throw new OperatorError('WORKSPACE_EDIT_ROLLBACK_POSTCONDITION_FAILED', 'Target changed before rollback cleanup.');
      }
      await removeIfExact(file.tempPath, file.beforeSha256);
      await removeIfExact(file.discardPath, file.afterSha256);
    }
  }

  async #reconcileJournal(
    action: ActionRequest,
    journalInput: RollbackJournal
  ): Promise<ProviderReconciliationResult> {
    const journal = validateJournal(journalInput);
    const parsed = await this.#parse({
      workspaceRootInput: journal.workspaceRoot,
      artifactId: journal.rollbackArtifactId
    });
    assertJournalMatches(journal, action.id, parsed.workspaceRoot, parsed.artifactId, parsed.payload);

    const states = await Promise.all(journal.files.map(async (file) => ({
      file,
      target: await inspectPath(file.targetPath),
      temp: await inspectPath(file.tempPath),
      discard: await inspectPath(file.discardPath)
    })));
    if (states.some((item) =>
      item.target.kind === 'unsafe' ||
      item.temp.kind === 'unsafe' ||
      item.discard.kind === 'unsafe'
    )) {
      return {
        status: 'uncertain',
        evidence: [evidence(
          'workspace_edit_rollback_reconciliation',
          'info',
          'Rollback path topology is unsafe; no automatic mutation was attempted.'
        )]
      };
    }

    const complete = states.every((item) =>
      item.target.kind === 'regular' &&
      item.target.sha256 === item.file.beforeSha256 &&
      item.temp.kind === 'missing' &&
      item.discard.kind === 'missing'
    );
    if (complete) {
      if (journal.phase !== 'COMMITTED') {
        const committed = { ...journal, phase: 'COMMITTED' as const, updatedAt: this.#now() };
        await this.#writeJournal(committed);
        return {
          status: 'completed',
          result: success(action, committed, 0, true),
          evidence: [evidence('workspace_edit_rollback_reconciliation', 'pass', 'Rollback completion was proven from exact hashes.')]
        };
      }
      return {
        status: 'completed',
        result: success(action, journal, 0, true),
        evidence: [evidence('workspace_edit_rollback_reconciliation', 'pass', 'Rollback remains exactly complete.')]
      };
    }

    try {
      await this.#resumeApply(journal, parsed.payload, {});
      const cleanup = { ...journal, phase: 'COMMITTED_CLEANUP' as const, updatedAt: this.#now() };
      await this.#writeJournal(cleanup);
      await this.#cleanup(cleanup);
      const committed = { ...cleanup, phase: 'COMMITTED' as const, updatedAt: this.#now() };
      await this.#writeJournal(committed);
      return {
        status: 'completed',
        result: success(action, committed, 0, true),
        evidence: [evidence(
          'workspace_edit_rollback_reconciliation',
          'pass',
          'Partial rollback was resumed to exact pre-edit hashes.'
        )]
      };
    } catch (error) {
      const op = asOperatorError(error, 'WORKSPACE_EDIT_ROLLBACK_RECONCILIATION_FAILED');
      return {
        status: 'uncertain',
        evidence: [evidence(
          'workspace_edit_rollback_reconciliation',
          'info',
          'Rollback could not be resumed without overwriting unknown bytes.',
          { code: op.code }
        )]
      };
    }
  }

  async #readJournal(actionId: string): Promise<RollbackJournal | undefined> {
    const file = rollbackJournalPath(this.#stateDir, actionId);
    try {
      return validateJournal(JSON.parse(await readDurableStateText(file, STATE_OPTIONS)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      if (error instanceof SyntaxError) throw corrupt('Rollback journal contains invalid JSON.');
      throw error;
    }
  }

  async #writeJournal(journal: RollbackJournal): Promise<void> {
    const valid = validateJournal(journal);
    await writeDurableStateText(
      rollbackJournalPath(this.#stateDir, valid.actionId),
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
    try { return await operation(); } finally { release(); }
  }
}

export function rollbackJournalPath(stateDir: string, actionId: string): string {
  const id = boundedString(actionId, 1024, 'actionId');
  const digestValue = sha256(Buffer.from(id, 'utf8'));
  return path.join(path.resolve(stateDir), 'workspace-edit-rollbacks', digestValue + '.json');
}

function actionInput(action: ActionRequest): { workspaceRootInput: string; artifactId: string } {
  const workspaceRootInput = String(action.input.workspaceRoot ?? '');
  if (!workspaceRootInput || workspaceRootInput.includes('\0')) {
    throw new OperatorError('WORKSPACE_EDIT_ROOT_REQUIRED', 'workspaceRoot is required.');
  }
  const artifactId = digest(String(action.input.rollbackArtifactId ?? ''), 'rollbackArtifactId');
  return { workspaceRootInput, artifactId };
}

function validatePayload(input: unknown): RollbackArtifactPayload {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new OperatorError('WORKSPACE_EDIT_ROLLBACK_ARTIFACT_INVALID', 'Rollback payload must be an object.');
  }
  const raw = input as Record<string, unknown>;
  if (raw.schemaVersion !== 1) {
    throw new OperatorError('WORKSPACE_EDIT_ROLLBACK_ARTIFACT_INVALID', 'Rollback payload schemaVersion must be 1.');
  }
  const transactionActionId = boundedString(raw.transactionActionId, 1024, 'transactionActionId');
  const planId = digest(raw.planId, 'planId');
  const workspaceRootDigest = digest(raw.workspaceRootDigest, 'workspaceRootDigest');
  if (!Array.isArray(raw.files) || raw.files.length < 1 || raw.files.length > 1000) {
    throw new OperatorError('WORKSPACE_EDIT_ROLLBACK_ARTIFACT_INVALID', 'Rollback file list is invalid.');
  }
  const seen = new Set<string>();
  const files = raw.files.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new OperatorError('WORKSPACE_EDIT_ROLLBACK_ARTIFACT_INVALID', 'Rollback file entry is invalid.');
    }
    const file = item as Record<string, unknown>;
    const relativePath = normalizeRelativePath(file.path);
    if (seen.has(relativePath)) {
      throw new OperatorError('WORKSPACE_EDIT_ROLLBACK_ARTIFACT_INVALID', 'Rollback target paths must be unique.');
    }
    seen.add(relativePath);
    const beforeSha256 = digest(file.beforeSha256, 'beforeSha256');
    const afterSha256 = digest(file.afterSha256, 'afterSha256');
    const mode = Number(file.mode);
    if (!Number.isSafeInteger(mode) || mode < 0 || mode > 0o7777) {
      throw new OperatorError('WORKSPACE_EDIT_ROLLBACK_ARTIFACT_INVALID', 'Rollback mode is invalid.');
    }
    const beforeText = String(file.beforeText ?? '');
    if (beforeText.includes('\0') || Buffer.byteLength(beforeText, 'utf8') > MAX_FILE_BYTES) {
      throw new OperatorError('WORKSPACE_EDIT_ROLLBACK_ARTIFACT_INVALID', 'Rollback source text is invalid.');
    }
    if (sha256(Buffer.from(beforeText, 'utf8')) !== beforeSha256) {
      throw new OperatorError('WORKSPACE_EDIT_ROLLBACK_ARTIFACT_INVALID', 'Rollback source bytes do not match beforeSha256.');
    }
    return { path: relativePath, beforeSha256, afterSha256, mode, beforeText };
  });
  return { schemaVersion: 1, transactionActionId, planId, workspaceRootDigest, files };
}

function validateJournal(input: unknown): RollbackJournal {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw corrupt('Rollback journal must be an object.');
  const raw = input as Record<string, unknown>;
  if (raw.schemaVersion !== 1) throw corrupt('Rollback journal schemaVersion must be 1.');
  const actionId = boundedString(raw.actionId, 1024, 'actionId');
  const rollbackArtifactId = digest(raw.rollbackArtifactId, 'rollbackArtifactId');
  const transactionActionId = boundedString(raw.transactionActionId, 1024, 'transactionActionId');
  const planId = digest(raw.planId, 'planId');
  const workspaceRoot = absolutePath(raw.workspaceRoot, 'workspaceRoot');
  const phases = new Set<RollbackPhase>(['PREPARED', 'APPLYING', 'COMMITTED_CLEANUP', 'COMMITTED']);
  if (!phases.has(raw.phase as RollbackPhase)) throw corrupt('Rollback journal phase is invalid.');
  if (!Array.isArray(raw.files) || raw.files.length < 1 || raw.files.length > 1000) throw corrupt('Rollback journal files are invalid.');
  const files = raw.files.map((item) => validateFileRecord(item, workspaceRoot));
  if (new Set(files.map((item) => canonicalPath(item.targetPath))).size !== files.length) {
    throw corrupt('Rollback journal targets must be unique.');
  }
  const createdAt = canonicalIso(raw.createdAt, 'createdAt');
  const updatedAt = canonicalIso(raw.updatedAt, 'updatedAt');
  if (Date.parse(updatedAt) < Date.parse(createdAt)) throw corrupt('Rollback updatedAt precedes createdAt.');
  return {
    schemaVersion: 1,
    actionId,
    rollbackArtifactId,
    transactionActionId,
    planId,
    workspaceRoot,
    phase: raw.phase as RollbackPhase,
    files,
    createdAt,
    updatedAt
  };
}

function validateFileRecord(input: unknown, workspaceRoot: string): RollbackFileRecord {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw corrupt('Rollback file record is invalid.');
  const raw = input as Record<string, unknown>;
  const relativePath = normalizeRelativePath(raw.path);
  const targetPath = absolutePath(raw.targetPath, 'targetPath');
  const tempPath = absolutePath(raw.tempPath, 'tempPath');
  const discardPath = absolutePath(raw.discardPath, 'discardPath');
  for (const candidate of [targetPath, tempPath, discardPath]) {
    if (!inside(candidate, workspaceRoot)) throw corrupt('Rollback journal path escapes workspace root.');
  }
  const expectedTarget = path.resolve(workspaceRoot, ...relativePath.split('/'));
  if (canonicalPath(expectedTarget) !== canonicalPath(targetPath)) throw corrupt('Rollback target path does not match relative path.');
  if (new Set([targetPath, tempPath, discardPath].map(canonicalPath)).size !== 3) {
    throw corrupt('Rollback journal paths must be distinct.');
  }
  const mode = Number(raw.mode);
  if (!Number.isSafeInteger(mode) || mode < 0 || mode > 0o7777) throw corrupt('Rollback mode is invalid.');
  return {
    path: relativePath,
    targetPath,
    tempPath,
    discardPath,
    beforeSha256: digest(raw.beforeSha256, 'beforeSha256'),
    afterSha256: digest(raw.afterSha256, 'afterSha256'),
    mode
  };
}

function assertJournalMatches(
  journal: RollbackJournal,
  actionId: string,
  workspaceRoot: string,
  artifactId: string,
  payload: RollbackArtifactPayload
): void {
  if (
    journal.actionId !== actionId ||
    journal.rollbackArtifactId !== artifactId ||
    journal.transactionActionId !== payload.transactionActionId ||
    journal.planId !== payload.planId ||
    canonicalPath(journal.workspaceRoot) !== canonicalPath(workspaceRoot)
  ) {
    throw new OperatorError(
      'WORKSPACE_EDIT_ROLLBACK_ACTION_REUSE_INVALID',
      'Rollback action id is already bound to different immutable rollback intent.'
    );
  }
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
    throw new OperatorError('WORKSPACE_EDIT_ROLLBACK_CLEANUP_AMBIGUOUS', 'Rollback cleanup refused unknown bytes.');
  }
  await fs.rm(file);
  if (process.platform !== 'win32') await syncDirectory(path.dirname(file));
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

function success(
  action: ActionRequest,
  journal: RollbackJournal,
  started: number,
  reconciled: boolean
): ActionResult {
  return {
    ok: true,
    capability: action.capability,
    provider: 'workspace.edit.rollback',
    output: {
      rollbackArtifactId: journal.rollbackArtifactId,
      transactionActionId: journal.transactionActionId,
      planId: journal.planId,
      workspaceRoot: journal.workspaceRoot,
      files: journal.files.map((file) => ({
        path: file.path,
        restoredSha256: file.beforeSha256,
        replacedSha256: file.afterSha256
      })),
      reconciled
    },
    evidence: [
      evidence(
        'workspace_edit_rollback',
        'pass',
        reconciled
          ? 'Committed edit rollback was re-established from exact target hashes.'
          : 'Committed edit rollback restored exact pre-edit hashes from an immutable rollback artifact.',
        { planId: journal.planId, fileCount: journal.files.length }
      ),
      evidence(
        'postcondition',
        'pass',
        'Every rollback target matches its exact pre-edit SHA-256.',
        { planId: journal.planId }
      )
    ],
    durationMs: started === 0 ? 0 : Math.round(performance.now() - started)
  };
}

function normalizeRelativePath(input: unknown): string {
  if (typeof input !== 'string' || !input || input.includes('\0') || input.includes('\\')) {
    throw new OperatorError('WORKSPACE_EDIT_ROLLBACK_ARTIFACT_INVALID', 'Rollback relative path is invalid.');
  }
  const normalized = path.posix.normalize(input);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
    throw new OperatorError('WORKSPACE_EDIT_ROLLBACK_ARTIFACT_INVALID', 'Rollback relative path escapes workspace.');
  }
  return normalized;
}

function absolutePath(input: unknown, label: string): string {
  const value = boundedString(input, 32 * 1024, label);
  if (!path.isAbsolute(value)) throw corrupt(label + ' must be absolute.');
  return path.resolve(value);
}

function boundedString(input: unknown, maxBytes: number, label: string): string {
  if (typeof input !== 'string' || !input || input.includes('\0') || Buffer.byteLength(input, 'utf8') > maxBytes) {
    throw corrupt(label + ' is invalid.');
  }
  return input;
}

function digest(input: unknown, label: string): string {
  const value = String(input ?? '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new OperatorError('WORKSPACE_EDIT_ROLLBACK_INPUT_INVALID', label + ' must be SHA-256.');
  }
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
  return new OperatorError('WORKSPACE_EDIT_ROLLBACK_CORRUPT', message);
}
