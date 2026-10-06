import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readDurableStateText, writeDurableStateText } from './durable-state.ts';
import { OperatorError } from './errors.ts';
import { resolveSupportedGitExecutable } from './trusted-executable.ts';

const NULL_GIT_CONFIG = process.platform === 'win32' ? 'NUL' : '/dev/null';
const SAFE_GIT_PREFIX = [
  '--no-pager',
  '--no-lazy-fetch',
  '-c', 'core.fsmonitor=false',
  '-c', 'core.hooksPath=' + NULL_GIT_CONFIG
];
const MAX_GIT_OUTPUT_BYTES = 2 * 1024 * 1024;
const RECORD_OPTIONS = {
  maxBytes: 256 * 1024,
  errorCode: 'DEVELOPER_WORKTREE_STATE_CORRUPT',
  invalidMessage: 'Developer worktree state is invalid.'
} as const;
const SESSION_ID = /^[A-Za-z0-9._:@-]{1,128}$/;
const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

export type DeveloperWorktreePhase =
  | 'CREATING'
  | 'ACTIVE'
  | 'RELEASING'
  | 'RELEASED';

export interface DeveloperWorktreeRecord {
  schemaVersion: 1;
  sessionId: string;
  repositoryRoot: string;
  worktreePath: string;
  baseCommit: string;
  phase: DeveloperWorktreePhase;
  createdAt: string;
  updatedAt: string;
  gitDir?: string;
  commonDir?: string;
}

export interface DeveloperWorktreeInspection {
  record: DeveloperWorktreeRecord;
  exists: boolean;
  head?: string;
  clean?: boolean;
  statusDigest?: string;
  fingerprint?: string;
}

export class DeveloperWorktreeManager {
  #allowedRepositoryRoots: string[];
  #worktreeRoot: string;
  #stateDir: string;
  #clock: () => Date;
  #serial: Promise<void> = Promise.resolve();
  #initialized = false;

  constructor(options: {
    allowedRepositoryRoots: string[];
    worktreeRoot: string;
    stateDir: string;
    clock?: () => Date;
  }) {
    if (!Array.isArray(options.allowedRepositoryRoots) || options.allowedRepositoryRoots.length < 1) {
      throw new OperatorError('DEVELOPER_WORKTREE_CONFIG_INVALID', 'At least one allowed repository root is required.');
    }
    this.#allowedRepositoryRoots = options.allowedRepositoryRoots.map((item) => path.resolve(item));
    this.#worktreeRoot = path.resolve(options.worktreeRoot);
    this.#stateDir = path.resolve(options.stateDir);
    this.#clock = options.clock ?? (() => new Date());
  }

  async create(input: {
    sessionId: string;
    repositoryRoot: string;
    baseCommit: string;
  }): Promise<DeveloperWorktreeInspection> {
    return await this.#enqueue(async () => {
      await this.#init();
      const sessionId = normalizeSessionId(input.sessionId);
      const baseCommit = normalizeCommit(input.baseCommit);
      const repositoryRoot = await this.#resolveRepositoryRoot(input.repositoryRoot);
      await assertNoRepoLocalContentFilters(repositoryRoot);
      await verifyCommit(repositoryRoot, baseCommit);

      const intendedPath = this.#worktreePath(sessionId);
      const existing = await this.#readRecord(sessionId);
      if (existing) {
        assertSameIntent(existing, repositoryRoot, baseCommit, intendedPath);
        if (existing.phase === 'RELEASED') {
          throw new OperatorError(
            'DEVELOPER_WORKTREE_SESSION_REUSED',
            'Released Developer Worktree session IDs cannot be reused.'
          );
        }
        const reconciled = await this.#reconcileRecord(existing);
        if (reconciled.record.phase === 'ACTIVE') return reconciled;
        if (reconciled.record.phase === 'RELEASING') {
          throw new OperatorError(
            'DEVELOPER_WORKTREE_RELEASE_IN_PROGRESS',
            'Developer Worktree release is already in progress.'
          );
        }
        if (reconciled.exists) {
          throw new OperatorError(
            'DEVELOPER_WORKTREE_CREATE_UNCERTAIN',
            'Developer Worktree creation is in an ambiguous state.'
          );
        }
      } else {
        await assertPathAbsent(intendedPath, 'Developer Worktree path already exists without an ownership record.');
      }

      const now = this.#now();
      const creating: DeveloperWorktreeRecord = {
        schemaVersion: 1,
        sessionId,
        repositoryRoot,
        worktreePath: intendedPath,
        baseCommit,
        phase: 'CREATING',
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      };
      await this.#writeRecord(creating);

      await runGit(repositoryRoot, ['worktree', 'add', '--detach', intendedPath, baseCommit]);
      const inspection = await this.#inspectActiveCandidate(creating);
      const active: DeveloperWorktreeRecord = {
        ...creating,
        phase: 'ACTIVE',
        gitDir: inspection.record.gitDir,
        commonDir: inspection.record.commonDir,
        updatedAt: this.#now()
      };
      await this.#writeRecord(active);
      return { ...inspection, record: active };
    });
  }

  async inspect(sessionIdInput: string): Promise<DeveloperWorktreeInspection> {
    return await this.#enqueue(async () => {
      await this.#init();
      const sessionId = normalizeSessionId(sessionIdInput);
      const record = await this.#requireRecord(sessionId);
      return await this.#reconcileRecord(record);
    });
  }

  async release(input: {
    sessionId: string;
    expectedFingerprint: string;
  }): Promise<DeveloperWorktreeInspection> {
    return await this.#enqueue(async () => {
      await this.#init();
      const sessionId = normalizeSessionId(input.sessionId);
      const expectedFingerprint = normalizeDigest(input.expectedFingerprint, 'expectedFingerprint');
      let record = await this.#requireRecord(sessionId);
      record = (await this.#reconcileRecord(record)).record;

      if (record.phase === 'RELEASED') {
        return { record, exists: false };
      }
      if (record.phase === 'CREATING') {
        throw new OperatorError(
          'DEVELOPER_WORKTREE_CREATE_INCOMPLETE',
          'Developer Worktree creation is not complete.'
        );
      }

      const inspected = await this.#inspectActiveCandidate(record);
      if (!inspected.exists || !inspected.fingerprint || inspected.clean !== true) {
        throw new OperatorError(
          'DEVELOPER_WORKTREE_DIRTY',
          'Developer Worktree must exist and be clean before release.'
        );
      }
      if (inspected.head !== record.baseCommit) {
        throw new OperatorError(
          'DEVELOPER_WORKTREE_HEAD_CHANGED',
          'Developer Worktree HEAD moved away from its original detached base commit; refusing deletion.'
        );
      }
      if (inspected.fingerprint !== expectedFingerprint) {
        throw new OperatorError(
          'DEVELOPER_WORKTREE_STATE_CHANGED',
          'Developer Worktree state changed after the supplied release precondition was captured.',
          { retryable: true }
        );
      }

      const releasing: DeveloperWorktreeRecord = {
        ...record,
        phase: 'RELEASING',
        updatedAt: this.#now()
      };
      await this.#writeRecord(releasing);

      await assertNoRepoLocalContentFilters(record.repositoryRoot);
      await runGit(record.repositoryRoot, ['worktree', 'remove', record.worktreePath]);

      const present = await listedWorktree(record.repositoryRoot, record.worktreePath);
      if (present || await pathExists(record.worktreePath)) {
        throw new OperatorError(
          'DEVELOPER_WORKTREE_RELEASE_POSTCONDITION_FAILED',
          'Git worktree removal returned but the owned worktree is still present.'
        );
      }

      const released: DeveloperWorktreeRecord = {
        ...releasing,
        phase: 'RELEASED',
        updatedAt: this.#now()
      };
      await this.#writeRecord(released);
      return { record: released, exists: false };
    });
  }

  async #reconcileRecord(
    recordInput: DeveloperWorktreeRecord
  ): Promise<DeveloperWorktreeInspection> {
    const record = validateRecord(recordInput, this.#worktreeRoot);
    if (record.phase === 'RELEASED') {
      const listed = await listedWorktree(record.repositoryRoot, record.worktreePath);
      const exists = await pathExists(record.worktreePath);
      if (listed || exists) {
        throw new OperatorError(
          'DEVELOPER_WORKTREE_RELEASE_CONTRADICTED',
          'A released Developer Worktree unexpectedly exists or is still registered.'
        );
      }
      return { record, exists: false };
    }

    if (record.phase === 'CREATING') {
      const exists = await pathExists(record.worktreePath);
      const listed = await listedWorktree(record.repositoryRoot, record.worktreePath);
      if (!exists && !listed) return { record, exists: false };
      if (exists !== listed) {
        throw new OperatorError(
          'DEVELOPER_WORKTREE_CREATE_UNCERTAIN',
          'Developer Worktree path and Git registration disagree during creation recovery.'
        );
      }
      const inspection = await this.#inspectActiveCandidate(record);
      const active: DeveloperWorktreeRecord = {
        ...record,
        phase: 'ACTIVE',
        gitDir: inspection.record.gitDir,
        commonDir: inspection.record.commonDir,
        updatedAt: this.#now()
      };
      await this.#writeRecord(active);
      return { ...inspection, record: active };
    }

    if (record.phase === 'RELEASING') {
      const exists = await pathExists(record.worktreePath);
      const listed = await listedWorktree(record.repositoryRoot, record.worktreePath);
      if (!exists && !listed) {
        const released: DeveloperWorktreeRecord = {
          ...record,
          phase: 'RELEASED',
          updatedAt: this.#now()
        };
        await this.#writeRecord(released);
        return { record: released, exists: false };
      }
      if (exists !== listed) {
        throw new OperatorError(
          'DEVELOPER_WORKTREE_RELEASE_UNCERTAIN',
          'Developer Worktree path and Git registration disagree during release recovery.'
        );
      }
    }

    return await this.#inspectActiveCandidate(record);
  }

  async #inspectActiveCandidate(
    recordInput: DeveloperWorktreeRecord
  ): Promise<DeveloperWorktreeInspection> {
    const record = validateRecord(recordInput, this.#worktreeRoot);
    await assertNoRepoLocalContentFilters(record.repositoryRoot);
    const stat = await fs.lstat(record.worktreePath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new OperatorError(
        'DEVELOPER_WORKTREE_PATH_UNSAFE',
        'Owned Developer Worktree path must be a real directory.'
      );
    }

    const realWorktree = await fs.realpath(record.worktreePath);
    if (canonicalPath(realWorktree) !== canonicalPath(record.worktreePath)) {
      throw new OperatorError(
        'DEVELOPER_WORKTREE_PATH_CHANGED',
        'Owned Developer Worktree resolved path changed.'
      );
    }

    const top = canonicalPath((await runGit(record.worktreePath, ['rev-parse', '--show-toplevel'])).stdout.trim());
    if (top !== canonicalPath(record.worktreePath)) {
      throw new OperatorError(
        'DEVELOPER_WORKTREE_ROOT_MISMATCH',
        'Git reports a different worktree root than the owned path.'
      );
    }

    const head = normalizeCommit(
      (await runGit(record.worktreePath, ['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim()
    );
    const gitDir = canonicalPath(
      (await runGit(record.worktreePath, ['rev-parse', '--absolute-git-dir'])).stdout.trim()
    );
    const commonRaw = (await runGit(record.worktreePath, ['rev-parse', '--git-common-dir'])).stdout.trim();
    const commonDir = canonicalPath(
      path.isAbsolute(commonRaw)
        ? commonRaw
        : path.resolve(record.worktreePath, commonRaw)
    );

    if (record.gitDir && canonicalPath(record.gitDir) !== gitDir) {
      throw new OperatorError(
        'DEVELOPER_WORKTREE_GITDIR_CHANGED',
        'Developer Worktree Git directory no longer matches its ownership record.'
      );
    }
    if (record.commonDir && canonicalPath(record.commonDir) !== commonDir) {
      throw new OperatorError(
        'DEVELOPER_WORKTREE_COMMONDIR_CHANGED',
        'Developer Worktree common Git directory no longer matches its ownership record.'
      );
    }

    const status = await runGit(record.worktreePath, [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
      '--ignore-submodules=all'
    ]);
    const statusDigest = sha256(Buffer.from(status.stdout, 'utf8'));
    const clean = status.stdout.length === 0;
    const fingerprint = sha256(Buffer.from(
      [
        record.sessionId,
        canonicalPath(record.repositoryRoot),
        canonicalPath(record.worktreePath),
        record.baseCommit,
        head,
        statusDigest
      ].join('\0'),
      'utf8'
    ));

    return {
      record: {
        ...record,
        gitDir,
        commonDir
      },
      exists: true,
      head,
      clean,
      statusDigest,
      fingerprint
    };
  }

  async #resolveRepositoryRoot(input: string): Promise<string> {
    const requested = path.resolve(String(input ?? ''));
    const stat = await fs.lstat(requested);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new OperatorError(
        'DEVELOPER_WORKTREE_REPOSITORY_INVALID',
        'repositoryRoot must be a real directory.'
      );
    }
    const real = await fs.realpath(requested);
    const allowed = await this.#canonicalAllowedRepositoryRoots();
    if (!allowed.some((root) => inside(real, root))) {
      throw new OperatorError(
        'DEVELOPER_WORKTREE_REPOSITORY_OUTSIDE_SCOPE',
        'repositoryRoot is outside configured repository roots.'
      );
    }
    const top = await runGit(real, ['rev-parse', '--show-toplevel']);
    const gitRoot = canonicalPath(top.stdout.trim());
    if (gitRoot !== canonicalPath(real)) {
      throw new OperatorError(
        'DEVELOPER_WORKTREE_REPOSITORY_ROOT_REQUIRED',
        'repositoryRoot must be the canonical Git toplevel.'
      );
    }
    return real;
  }

  async #canonicalAllowedRepositoryRoots(): Promise<string[]> {
    const roots: string[] = [];
    for (const configured of this.#allowedRepositoryRoots) {
      try {
        roots.push(await fs.realpath(configured));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return roots;
  }

  async #init(): Promise<void> {
    if (this.#initialized) return;
    await fs.mkdir(this.#worktreeRoot, { recursive: true, mode: 0o700 });
    await fs.mkdir(this.#stateDir, { recursive: true, mode: 0o700 });

    const [worktreeStat, stateStat] = await Promise.all([
      fs.lstat(this.#worktreeRoot),
      fs.lstat(this.#stateDir)
    ]);
    if (!worktreeStat.isDirectory() || worktreeStat.isSymbolicLink()) {
      throw new OperatorError(
        'DEVELOPER_WORKTREE_ROOT_UNSAFE',
        'worktreeRoot must be a real directory.'
      );
    }
    if (!stateStat.isDirectory() || stateStat.isSymbolicLink()) {
      throw new OperatorError(
        'DEVELOPER_WORKTREE_STATE_UNSAFE',
        'stateDir must be a real directory.'
      );
    }

    const realWorktreeRoot = await fs.realpath(this.#worktreeRoot);
    const realStateDir = await fs.realpath(this.#stateDir);
    if (
      inside(realStateDir, realWorktreeRoot) ||
      inside(realWorktreeRoot, realStateDir)
    ) {
      throw new OperatorError(
        'DEVELOPER_WORKTREE_CONTROL_BOUNDARY_INVALID',
        'stateDir and worktreeRoot must be separate non-nested directories.'
      );
    }

    const allowed = await this.#canonicalAllowedRepositoryRoots();
    for (const root of allowed) {
      if (inside(realStateDir, root)) {
        throw new OperatorError(
          'DEVELOPER_WORKTREE_STATE_INSIDE_PROJECT',
          'Developer Worktree ownership state must live outside authorized repository roots.'
        );
      }
      if (inside(realWorktreeRoot, root)) {
        throw new OperatorError(
          'DEVELOPER_WORKTREE_ROOT_INSIDE_PROJECT',
          'Developer Worktree isolation root must live outside source repository roots.'
        );
      }
    }

    this.#initialized = true;
  }

  #worktreePath(sessionId: string): string {
    const key = sha256(Buffer.from(sessionId, 'utf8')).slice(0, 32);
    return path.join(this.#worktreeRoot, key);
  }

  #recordPath(sessionId: string): string {
    const key = sha256(Buffer.from(sessionId, 'utf8'));
    return path.join(this.#stateDir, 'developer-worktrees', key + '.json');
  }

  async #readRecord(sessionId: string): Promise<DeveloperWorktreeRecord | undefined> {
    try {
      return validateRecord(
        JSON.parse(await readDurableStateText(this.#recordPath(sessionId), RECORD_OPTIONS)),
        this.#worktreeRoot
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      if (error instanceof SyntaxError) {
        throw new OperatorError(
          'DEVELOPER_WORKTREE_STATE_CORRUPT',
          'Developer Worktree ownership record contains invalid JSON.'
        );
      }
      throw error;
    }
  }

  async #requireRecord(sessionId: string): Promise<DeveloperWorktreeRecord> {
    const record = await this.#readRecord(sessionId);
    if (!record) {
      throw new OperatorError(
        'DEVELOPER_WORKTREE_NOT_FOUND',
        'Developer Worktree session was not found.'
      );
    }
    return record;
  }

  async #writeRecord(recordInput: DeveloperWorktreeRecord): Promise<void> {
    const record = validateRecord(recordInput, this.#worktreeRoot);
    await writeDurableStateText(
      this.#recordPath(record.sessionId),
      JSON.stringify(record),
      RECORD_OPTIONS
    );
  }

  #now(): string {
    const value = this.#clock().toISOString();
    if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
      throw new OperatorError(
        'DEVELOPER_WORKTREE_CLOCK_INVALID',
        'Developer Worktree clock must return a canonical date.'
      );
    }
    return value;
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

function validateRecord(
  input: unknown,
  worktreeRoot: string
): DeveloperWorktreeRecord {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw corrupt('Developer Worktree ownership record must be an object.');
  }
  const raw = input as Record<string, unknown>;
  if (raw.schemaVersion !== 1) throw corrupt('Unsupported Developer Worktree schema.');
  const sessionId = normalizeSessionId(raw.sessionId);
  const repositoryRoot = absolutePath(raw.repositoryRoot, 'repositoryRoot');
  const worktreePath = absolutePath(raw.worktreePath, 'worktreePath');
  if (!inside(worktreePath, worktreeRoot)) {
    throw corrupt('Owned worktree path escapes configured worktreeRoot.');
  }
  const expected = path.join(
    worktreeRoot,
    sha256(Buffer.from(sessionId, 'utf8')).slice(0, 32)
  );
  if (canonicalPath(expected) !== canonicalPath(worktreePath)) {
    throw corrupt('Owned worktree path does not match the session identity.');
  }
  const baseCommit = normalizeCommit(raw.baseCommit);
  const phase = String(raw.phase ?? '') as DeveloperWorktreePhase;
  if (!['CREATING', 'ACTIVE', 'RELEASING', 'RELEASED'].includes(phase)) {
    throw corrupt('Developer Worktree phase is invalid.');
  }
  const createdAt = canonicalIso(raw.createdAt, 'createdAt');
  const updatedAt = canonicalIso(raw.updatedAt, 'updatedAt');
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw corrupt('Developer Worktree updatedAt precedes createdAt.');
  }
  const gitDir = raw.gitDir === undefined
    ? undefined
    : absolutePath(raw.gitDir, 'gitDir');
  const commonDir = raw.commonDir === undefined
    ? undefined
    : absolutePath(raw.commonDir, 'commonDir');
  if (
    (phase === 'ACTIVE' || phase === 'RELEASING') &&
    (!gitDir || !commonDir)
  ) {
    throw corrupt('Active Developer Worktree ownership record lacks Git identity.');
  }
  return {
    schemaVersion: 1,
    sessionId,
    repositoryRoot,
    worktreePath,
    baseCommit,
    phase,
    createdAt,
    updatedAt,
    ...(gitDir ? { gitDir } : {}),
    ...(commonDir ? { commonDir } : {})
  };
}

async function verifyCommit(repositoryRoot: string, commit: string): Promise<void> {
  const resolved = normalizeCommit(
    (await runGit(repositoryRoot, ['rev-parse', '--verify', commit + '^{commit}'])).stdout.trim()
  );
  if (resolved.toLowerCase() !== commit.toLowerCase()) {
    throw new OperatorError(
      'DEVELOPER_WORKTREE_COMMIT_MISMATCH',
      'baseCommit does not resolve to the exact requested commit.'
    );
  }
}

async function assertNoRepoLocalContentFilters(repositoryRoot: string): Promise<void> {
  const result = await runGit(
    repositoryRoot,
    ['config', '--local', '--name-only', '--get-regexp', '^filter\..*\.(clean|smudge|process)$'],
    true
  );
  if (result.code === 0 && result.stdout.trim()) {
    throw new OperatorError(
      'DEVELOPER_WORKTREE_CONTENT_FILTER_DENIED',
      'Repository-local Git content filters are denied because worktree checkout could execute them.'
    );
  }
  if (![0, 1].includes(result.code)) {
    throw new OperatorError(
      'DEVELOPER_WORKTREE_CONFIG_INSPECTION_FAILED',
      result.stderr.trim() || 'Unable to inspect repository-local Git filters.'
    );
  }
}

async function listedWorktree(repositoryRoot: string, candidatePath: string): Promise<boolean> {
  const result = await runGit(repositoryRoot, ['worktree', 'list', '--porcelain', '-z']);
  const canonicalCandidate = canonicalPath(candidatePath);
  const fields = result.stdout.split('\0').filter(Boolean);
  for (const field of fields) {
    if (!field.startsWith('worktree ')) continue;
    const listed = canonicalPath(field.slice('worktree '.length));
    if (listed === canonicalCandidate) return true;
  }
  return false;
}

async function runGit(
  cwd: string,
  args: string[],
  allowNonZero = false
): Promise<{ code: number; stdout: string; stderr: string }> {
  const environment = gitEnvironment();
  const executable = resolveSupportedGitExecutable(environment);
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, [...SAFE_GIT_PREFIX, ...args], {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: environment
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let timedOut = false;
    const capture = (bucket: Buffer[]) => (chunk: Buffer) => {
      if (bytes >= MAX_GIT_OUTPUT_BYTES) return;
      const remaining = MAX_GIT_OUTPUT_BYTES - bytes;
      const part = chunk.subarray(0, remaining);
      bucket.push(part);
      bytes += part.byteLength;
    };
    child.stdout.on('data', capture(stdout));
    child.stderr.on('data', capture(stderr));
    child.once('error', reject);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1000).unref();
    }, 60_000);
    timer.unref();
    child.once('close', (code) => {
      clearTimeout(timer);
      const result = {
        code: code ?? -1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8')
      };
      if (timedOut) {
        reject(new OperatorError(
          'DEVELOPER_WORKTREE_GIT_TIMEOUT',
          'Git worktree operation exceeded the bounded timeout.'
        ));
        return;
      }
      if (result.code !== 0 && !allowNonZero) {
        reject(new OperatorError(
          'DEVELOPER_WORKTREE_GIT_FAILED',
          result.stderr.trim().slice(0, 2000) ||
            ('Git worktree operation failed with exit ' + result.code + '.')
        ));
        return;
      }
      resolve(result);
    });
  });
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    GIT_PAGER: '',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_GLOBAL: NULL_GIT_CONFIG,
    GIT_CONFIG_SYSTEM: NULL_GIT_CONFIG,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_NO_LAZY_FETCH: '1'
  };
  for (const key of [
    'PATH', 'Path', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC',
    'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'USER', 'USERNAME',
    'LOGNAME', 'TMP', 'TEMP', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE'
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

function assertSameIntent(
  record: DeveloperWorktreeRecord,
  repositoryRoot: string,
  baseCommit: string,
  intendedPath: string
): void {
  if (
    canonicalPath(record.repositoryRoot) !== canonicalPath(repositoryRoot) ||
    record.baseCommit.toLowerCase() !== baseCommit.toLowerCase() ||
    canonicalPath(record.worktreePath) !== canonicalPath(intendedPath)
  ) {
    throw new OperatorError(
      'DEVELOPER_WORKTREE_SESSION_REBOUND',
      'Developer Worktree session ID is already bound to a different repository, commit, or path.'
    );
  }
}

async function assertPathAbsent(file: string, message: string): Promise<void> {
  if (await pathExists(file)) {
    throw new OperatorError('DEVELOPER_WORKTREE_PATH_COLLISION', message);
  }
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await fs.lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function normalizeSessionId(input: unknown): string {
  const value = String(input ?? '');
  if (!SESSION_ID.test(value)) {
    throw new OperatorError(
      'DEVELOPER_WORKTREE_SESSION_ID_INVALID',
      'sessionId must be a bounded safe identifier.'
    );
  }
  return value;
}

function normalizeCommit(input: unknown): string {
  const value = String(input ?? '').toLowerCase();
  if (!COMMIT_ID.test(value)) {
    throw new OperatorError(
      'DEVELOPER_WORKTREE_COMMIT_INVALID',
      'baseCommit must be a full Git commit object ID.'
    );
  }
  return value;
}

function normalizeDigest(input: unknown, label: string): string {
  const value = String(input ?? '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new OperatorError(
      'DEVELOPER_WORKTREE_PRECONDITION_INVALID',
      label + ' must be SHA-256.'
    );
  }
  return value;
}

function absolutePath(input: unknown, label: string): string {
  const value = String(input ?? '');
  if (!value || value.includes('\0') || !path.isAbsolute(value)) {
    throw corrupt(label + ' must be an absolute path.');
  }
  return path.resolve(value);
}

function canonicalIso(input: unknown, label: string): string {
  const value = String(input ?? '');
  if (
    !value ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw corrupt(label + ' must be canonical ISO.');
  }
  return value;
}

function canonicalPath(value: string): string {
  const normalized = path.resolve(value).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function inside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function sha256(bytes: Uint8Array): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function corrupt(message: string): OperatorError {
  return new OperatorError('DEVELOPER_WORKTREE_STATE_CORRUPT', message);
}
