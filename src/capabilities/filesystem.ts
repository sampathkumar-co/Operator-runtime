import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { ActionRequest, ActionResult, ActionRisk, CapabilityProvider, CapabilityScore } from '../core/types.ts';
import { evidence } from '../core/evidence.ts';
import { OperatorError } from '../core/errors.ts';
import { PathScope } from './path-scope.ts';

function sha256(buffer: Uint8Array): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

const DEFAULT_MAX_READ_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_WRITE_BYTES = 2 * 1024 * 1024;
const MAX_CONFIGURED_IO_BYTES = 64 * 1024 * 1024;
const MAX_SEARCH_RESULTS = 1000;
const MAX_SEARCH_DEPTH = 20;
const MAX_SEARCH_VISITS = 100_000;

const SCORE: CapabilityScore = {
  reliability: 0.98,
  latency: 0.97,
  determinism: 0.99,
  security: 0.96,
  reversibility: 0.78,
  informationQuality: 0.99,
  interactionCost: 0.01
};

export class FilesystemProvider implements CapabilityProvider {
  readonly name = 'filesystem.native';
  #scope: PathScope;
  #maxReadBytes: number;
  #maxWriteBytes: number;
  #replaceClaimHook?: (filePath: string) => Promise<void> | void;
  #pathLeaseHook?: (capability: string, filePath: string) => Promise<void> | void;

  constructor(options: {
    allowedRoots: string[];
    maxReadBytes?: number;
    maxWriteBytes?: number;
    replaceClaimHook?: (filePath: string) => Promise<void> | void;
    pathLeaseHook?: (capability: string, filePath: string) => Promise<void> | void;
    windowsPathLeaseExecutable?: string;
  }) {
    this.#scope = new PathScope(options.allowedRoots, { windowsPathLeaseExecutable: options.windowsPathLeaseExecutable });
    this.#maxReadBytes = boundedBytes(options.maxReadBytes, DEFAULT_MAX_READ_BYTES);
    this.#maxWriteBytes = boundedBytes(options.maxWriteBytes, DEFAULT_MAX_WRITE_BYTES);
    this.#replaceClaimHook = options.replaceClaimHook;
    this.#pathLeaseHook = options.pathLeaseHook;
  }

  supports(action: ActionRequest): boolean {
    return ['file.read', 'file.list', 'file.write', 'file.create', 'file.replace', 'file.info', 'file.search', 'file.manage'].includes(action.capability);
  }

  resolveRisk(action: ActionRequest): ActionRisk {
    if (action.capability !== 'file.manage') throw new OperatorError('CAPABILITY_RISK_UNRESOLVED', 'Filesystem dynamic risk applies only to file.manage.');
    const operation = String(action.input.operation ?? '');
    if (operation === 'mkdir' || operation === 'copy') return 'write';
    if (operation === 'move' || operation === 'remove') return 'destructive';
    throw new OperatorError('FILESYSTEM_INPUT_INVALID', 'file.manage operation must be mkdir, copy, move, or remove.');
  }

  score(): CapabilityScore { return SCORE; }

  async execute(action: ActionRequest): Promise<ActionResult> {
    const started = performance.now();
    try {
      if (action.capability === 'file.read') return await this.#read(action, started);
      if (action.capability === 'file.list') return await this.#list(action, started);
      if (action.capability === 'file.info') return await this.#info(action, started);
      if (action.capability === 'file.search') return await this.#search(action, started);
      if (action.capability === 'file.manage') return await this.#manage(action, started);
      if (['file.write', 'file.create', 'file.replace'].includes(action.capability)) return await this.#write(action, started);
      throw new OperatorError('UNSUPPORTED_ACTION', action.capability);
    } catch (error) {
      const op = error instanceof OperatorError
        ? error
        : new OperatorError('FILESYSTEM_ERROR', error instanceof Error ? error.message : String(error));
      return {
        ok: false,
        capability: action.capability,
        provider: this.name,
        evidence: [evidence('filesystem', 'fail', op.message, { code: op.code })],
        error: { code: op.code, message: op.message, retryable: op.retryable },
        durationMs: Math.round(performance.now() - started)
      };
    }
  }

  async #read(action: ActionRequest, started: number): Promise<ActionResult> {
    const requested = requiredString(action.input.path, 'path');
    return await this.#scope.withExisting(requested, async (filePath) => {
      await this.#pathLeaseHook?.(action.capability, filePath);
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) throw new OperatorError('NOT_A_FILE', 'Requested path is not a file.');
      if (stat.size > this.#maxReadBytes) {
        throw new OperatorError('READ_TOO_LARGE', `File exceeds ${this.#maxReadBytes} byte read limit.`, { details: { size: stat.size } });
      }
      const data = await fs.readFile(filePath);
      const encoding = action.input.encoding === 'base64' ? 'base64' : 'utf8';
      const digest = sha256(data);
      return {
        ok: true,
        capability: action.capability,
        provider: this.name,
        output: { path: filePath, size: data.byteLength, sha256: digest, content: data.toString(encoding) },
        evidence: [evidence('file_read', 'pass', 'File read from authorized scope.', { path: filePath, size: data.byteLength, sha256: digest })],
        durationMs: Math.round(performance.now() - started)
      };
    });
  }

  async #list(action: ActionRequest, started: number): Promise<ActionResult> {
    const requested = requiredString(action.input.path, 'path');
    return await this.#scope.withExisting(requested, async (dirPath) => {
      await this.#pathLeaseHook?.(action.capability, dirPath);
      const stat = await fs.stat(dirPath);
      if (!stat.isDirectory()) throw new OperatorError('NOT_A_DIRECTORY', 'Requested path is not a directory.');
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      const bounded = entries.slice(0, 500).map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : entry.isSymbolicLink() ? 'symlink' : 'other'
      }));
      return {
        ok: true,
        capability: action.capability,
        provider: this.name,
        output: { path: dirPath, entries: bounded, truncated: entries.length > bounded.length },
        evidence: [evidence('directory_list', 'pass', 'Directory listed from authorized scope.', { path: dirPath, count: bounded.length })],
        durationMs: Math.round(performance.now() - started)
      };
    });
  }

  async #info(action: ActionRequest, started: number): Promise<ActionResult> {
    const requested = requiredString(action.input.path, 'path');
    return await this.#scope.withExisting(requested, async (resolved) => {
      await this.#pathLeaseHook?.(action.capability, resolved);
      const stat = await fs.stat(resolved);
      const output: Record<string, unknown> = {
        path: resolved,
        type: stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'other',
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        createdAt: stat.birthtime.toISOString(),
        mode: stat.mode
      };
      if (stat.isFile() && stat.size <= this.#maxReadBytes) output.sha256 = sha256(await fs.readFile(resolved));
      return {
        ok: true, capability: action.capability, provider: this.name, output,
        evidence: [evidence('file_info', 'pass', 'Filesystem metadata inspected inside authorized scope.', { path: resolved, type: output.type, size: stat.size })],
        durationMs: Math.round(performance.now() - started)
      };
    });
  }

  async #search(action: ActionRequest, started: number): Promise<ActionResult> {
    const requested = requiredString(action.input.path, 'path');
    const query = requiredString(action.input.query, 'query').toLowerCase();
    if (query.length > 512) throw new OperatorError('FILESYSTEM_INPUT_INVALID', 'Search query exceeds 512 characters.');
    const maxResults = boundedInteger(action.input.maxResults, 100, 1, MAX_SEARCH_RESULTS);
    const maxDepth = boundedInteger(action.input.maxDepth, 8, 0, MAX_SEARCH_DEPTH);
    const kind = ['all', 'file', 'directory'].includes(String(action.input.kind ?? 'all')) ? String(action.input.kind ?? 'all') : 'all';
    return await this.#scope.withExisting(requested, async (root) => {
      await this.#pathLeaseHook?.(action.capability, root);
      const stat = await fs.stat(root);
      if (!stat.isDirectory()) throw new OperatorError('NOT_A_DIRECTORY', 'Search root is not a directory.');
      const results: Array<{ path: string; name: string; type: 'file' | 'directory'; size?: number }> = [];
      const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
      let visited = 0;
      let truncated = false;
      while (queue.length > 0 && results.length < maxResults && visited < MAX_SEARCH_VISITS) {
        const current = queue.shift()!;
        const entries = await fs.readdir(current.dir, { withFileTypes: true });
        for (const entry of entries) {
          visited += 1;
          if (visited >= MAX_SEARCH_VISITS) { truncated = true; break; }
          if (entry.isSymbolicLink()) continue;
          if (!entry.isDirectory() && !entry.isFile()) continue;
          const type = entry.isDirectory() ? 'directory' as const : 'file' as const;
          const full = path.join(current.dir, entry.name);
          if (entry.name.toLowerCase().includes(query) && (kind === 'all' || kind === type)) {
            const item: { path: string; name: string; type: 'file' | 'directory'; size?: number } = { path: full, name: entry.name, type };
            if (type === 'file') item.size = (await fs.stat(full)).size;
            results.push(item);
            if (results.length >= maxResults) { truncated = true; break; }
          }
          if (entry.isDirectory() && current.depth < maxDepth) queue.push({ dir: full, depth: current.depth + 1 });
        }
      }
      if (queue.length > 0 || visited >= MAX_SEARCH_VISITS) truncated = true;
      return {
        ok: true, capability: action.capability, provider: this.name,
        output: { root, query, results, visited, truncated },
        evidence: [evidence('file_search', 'pass', 'Bounded recursive filename search completed without following symlinks.', { root, resultCount: results.length, visited, truncated })],
        durationMs: Math.round(performance.now() - started)
      };
    });
  }

  async #manage(action: ActionRequest, started: number): Promise<ActionResult> {
    const operation = String(action.input.operation ?? '');
    if (operation === 'mkdir') {
      const requested = requiredString(action.input.path, 'path');
      return await this.#scope.withForWrite(requested, async (target) => {
        await this.#pathLeaseHook?.(action.capability, target);
        await fs.mkdir(target, { recursive: action.input.recursive === true });
        const stat = await fs.stat(target);
        if (!stat.isDirectory()) throw new OperatorError('FILE_MANAGE_POSTCONDITION_FAILED', 'Created path is not a directory.');
        return {
          ok: true, capability: action.capability, provider: this.name, output: { operation, path: target },
          evidence: [evidence('directory_create', 'pass', 'Directory created inside authorized scope.', { path: target })],
          durationMs: Math.round(performance.now() - started)
        };
      });
    }
    if (operation === 'copy') {
      const sourceInput = requiredString(action.input.source, 'source');
      const destinationInput = requiredString(action.input.destination, 'destination');
      return await this.#scope.withForWrite(sourceInput, async (source) => await this.#scope.withForWrite(destinationInput, async (destination) => {
        await this.#pathLeaseHook?.(action.capability, source);
        await this.#pathLeaseHook?.(action.capability, destination);
        const sourceStat = await fs.lstat(source);
        if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new OperatorError('FILE_COPY_TYPE_DENIED', 'file.manage copy currently accepts only regular files.');
        await assertMissing(destination, 'Copy destination already exists.');
        await fs.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
        const [before, after] = await Promise.all([fs.readFile(source), fs.readFile(destination)]);
        const sourceSha = sha256(before);
        const destinationSha = sha256(after);
        if (sourceSha !== destinationSha) throw new OperatorError('FILE_MANAGE_POSTCONDITION_FAILED', 'Copied file hash does not match source.');
        return {
          ok: true, capability: action.capability, provider: this.name,
          output: { operation, source, destination, sha256: destinationSha, bytes: after.byteLength },
          evidence: [evidence('file_copy', 'pass', 'Regular file copied without overwrite and verified by SHA-256.', { source, destination, sha256: destinationSha })],
          durationMs: Math.round(performance.now() - started)
        };
      }));
    }
    if (operation === 'move') {
      const sourceInput = requiredString(action.input.source, 'source');
      const destinationInput = requiredString(action.input.destination, 'destination');
      return await this.#scope.withExisting(sourceInput, async (source) => await this.#scope.withForWrite(destinationInput, async (destination) => {
        await this.#pathLeaseHook?.(action.capability, source);
        await this.#pathLeaseHook?.(action.capability, destination);
        const sourceStat = await fs.lstat(source);
        if (sourceStat.isSymbolicLink()) throw new OperatorError('FILE_MOVE_SYMLINK_DENIED', 'Refusing to move a symbolic link.');
        await assertMissing(destination, 'Move destination already exists.');
        const expectedSha = sourceStat.isFile() ? normalizeExpectedSha(action.input.expectedSha256) : undefined;
        if (sourceStat.isFile()) {
          if (!expectedSha) throw new OperatorError('PRECONDITION_REQUIRED', 'Moving a file requires expectedSha256 from a fresh file.info or file.read.');
          const actual = sha256(await fs.readFile(source));
          if (actual !== expectedSha) throw new OperatorError('PRECONDITION_FAILED', 'Move source changed since it was inspected.', { details: { expectedSha, actualSha: actual } });
        }
        await fs.rename(source, destination);
        await assertMissing(source, 'Move source still exists after rename.', true);
        const movedStat = await fs.stat(destination);
        return {
          ok: true, capability: action.capability, provider: this.name,
          output: { operation, source, destination, type: movedStat.isDirectory() ? 'directory' : 'file' },
          evidence: [evidence('file_move', 'pass', 'Path moved inside authorized scope without overwrite.', { source, destination })],
          durationMs: Math.round(performance.now() - started)
        };
      }));
    }
    if (operation === 'remove') {
      const requested = requiredString(action.input.path, 'path');
      return await this.#scope.withForWrite(requested, async (target) => {
        await this.#pathLeaseHook?.(action.capability, target);
        let stat;
        try { stat = await fs.lstat(target); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new OperatorError('TARGET_MISSING', 'Remove target does not exist.');
          throw error;
        }
        if (stat.isSymbolicLink()) throw new OperatorError('FILE_REMOVE_SYMLINK_DENIED', 'Refusing to remove a symbolic link through this capability.');
        if (stat.isFile()) {
          const expectedSha = normalizeExpectedSha(action.input.expectedSha256);
          if (!expectedSha) throw new OperatorError('PRECONDITION_REQUIRED', 'Removing a file requires expectedSha256 from a fresh file.info or file.read.');
          const actual = sha256(await fs.readFile(target));
          if (actual !== expectedSha) throw new OperatorError('PRECONDITION_FAILED', 'Remove target changed since it was inspected.', { details: { expectedSha, actualSha: actual } });
          await fs.rm(target);
        } else if (stat.isDirectory()) {
          const entries = await fs.readdir(target);
          if (entries.length !== 0) throw new OperatorError('DIRECTORY_NOT_EMPTY', 'Directory removal is limited to empty directories.');
          await fs.rmdir(target);
        } else throw new OperatorError('FILE_REMOVE_TYPE_DENIED', 'Only regular files or empty directories can be removed.');
        await assertMissing(target, 'Removed path still exists.', true);
        return {
          ok: true, capability: action.capability, provider: this.name, output: { operation, path: target },
          evidence: [evidence('file_remove', 'pass', 'Path removed with bounded destructive semantics.', { path: target })],
          durationMs: Math.round(performance.now() - started)
        };
      });
    }
    throw new OperatorError('FILESYSTEM_INPUT_INVALID', 'file.manage operation must be mkdir, copy, move, or remove.');
  }

  async #write(action: ActionRequest, started: number): Promise<ActionResult> {
    const requested = requiredString(action.input.path, 'path');
    if (typeof action.input.content !== 'string') throw new OperatorError('WRITE_CONTENT_INVALID', 'File content must be a string.');
    const content = action.input.content;
    const contentBytes = Buffer.byteLength(content, 'utf8');
    if (contentBytes > this.#maxWriteBytes) {
      throw new OperatorError('WRITE_TOO_LARGE', `Content exceeds ${this.#maxWriteBytes} byte write limit.`, { details: { size: contentBytes } });
    }
    const expectedSha = normalizeExpectedSha(action.input.expectedSha256);
    const mode = action.capability === 'file.create' ? 'create' : action.capability === 'file.replace' ? 'replace' : 'write';
    if (mode === 'replace' && !expectedSha) {
      throw new OperatorError('PRECONDITION_REQUIRED', 'file.replace requires expectedSha256 from a fresh file.read.');
    }

    return await this.#scope.withForWrite(requested, async (filePath) => {
      await this.#pathLeaseHook?.(action.capability, filePath);
      let beforeSha: string | null = null;
      try {
        const targetStat = await fs.lstat(filePath);
        if (targetStat.isSymbolicLink()) {
          throw new OperatorError('WRITE_SYMLINK_DENIED', 'Refusing to write through or replace an existing symbolic link.');
        }
        if (!targetStat.isFile()) throw new OperatorError('NOT_A_FILE', 'Existing write target is not a regular file.');
        if (mode === 'create') throw new OperatorError('TARGET_EXISTS', 'file.create refuses to overwrite an existing file.');
        const before = await fs.readFile(filePath);
        beforeSha = sha256(before);
        if (expectedSha && expectedSha !== beforeSha) {
          throw new OperatorError('PRECONDITION_FAILED', 'File changed since it was inspected.', { details: { expectedSha, actualSha: beforeSha } });
        }
      } catch (error) {
        if (error instanceof OperatorError) throw error;
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') throw error;
        if (mode === 'replace') throw new OperatorError('TARGET_MISSING', 'file.replace requires an existing file.');
        if (expectedSha) throw new OperatorError('PRECONDITION_FAILED', 'Expected existing file is missing.');
      }

      const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.operator-${crypto.randomUUID()}.tmp`);
      let renamed = false;
      try {
        await fs.writeFile(tempPath, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        if (mode === 'create') {
          await fs.writeFile(filePath, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
          await fs.rm(tempPath, { force: true });
        } else if (mode === 'replace') {
          beforeSha = await replaceWithExpectedSha(filePath, tempPath, expectedSha!, this.#replaceClaimHook);
        } else {
          await fs.rename(tempPath, filePath);
        }
        renamed = true;
      } finally {
        if (!renamed) await fs.rm(tempPath, { force: true }).catch(() => undefined);
      }

      const after = await fs.readFile(filePath);
      const afterSha = sha256(after);
      if (afterSha !== sha256(Buffer.from(content, 'utf8'))) {
        throw new OperatorError('WRITE_POSTCONDITION_FAILED', 'Written bytes do not match requested content.');
      }

      return {
        ok: true,
        capability: action.capability,
        provider: this.name,
        output: { path: filePath, bytes: after.byteLength, beforeSha256: beforeSha, afterSha256: afterSha },
        evidence: [
          evidence('file_write', 'pass', 'Atomic file write completed inside authorized scope.', { path: filePath }),
          evidence('postcondition', 'pass', 'Written bytes match requested content.', { afterSha256: afterSha, bytes: after.byteLength })
        ],
        durationMs: Math.round(performance.now() - started)
      };
    });
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new OperatorError('FILESYSTEM_INPUT_INVALID', `${field} must be a non-empty string without NUL bytes.`);
  }
  return value;
}

function normalizeExpectedSha(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/i.test(value)) {
    throw new OperatorError('PRECONDITION_INVALID', 'expectedSha256 must be exactly 64 hexadecimal characters.');
  }
  return value.toLowerCase();
}

function boundedBytes(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), 1), MAX_CONFIGURED_IO_BYTES);
}

async function replaceWithExpectedSha(
  filePath: string,
  tempPath: string,
  expectedSha: string,
  afterClaim?: (filePath: string) => Promise<void> | void
): Promise<string> {
  const backupPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.operator-${crypto.randomUUID()}.bak`);
  let claimed = false;
  try {
    try { await fs.rename(filePath, backupPath); claimed = true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new OperatorError('TARGET_MISSING', 'file.replace requires an existing file.');
      throw error;
    }
    const stat = await fs.lstat(backupPath);
    if (stat.isSymbolicLink()) throw new OperatorError('WRITE_SYMLINK_DENIED', 'Refusing to replace a symbolic link.');
    if (!stat.isFile()) throw new OperatorError('NOT_A_FILE', 'Existing write target is not a regular file.');
    const before = await fs.readFile(backupPath);
    const beforeSha = sha256(before);
    if (beforeSha !== expectedSha) throw new OperatorError('PRECONDITION_FAILED', 'File changed since it was inspected.', { details: { expectedSha, actualSha: beforeSha } });
    await afterClaim?.(filePath);
    try { await fs.link(tempPath, filePath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new OperatorError('PRECONDITION_FAILED', 'File changed during replacement.');
      throw error;
    }
    await fs.rm(tempPath, { force: true });
    await fs.rm(backupPath, { force: true });
    claimed = false;
    return beforeSha;
  } finally {
    if (claimed) await restoreClaimedPath(backupPath, filePath);
  }
}
async function restoreClaimedPath(backupPath: string, filePath: string): Promise<void> {
  try {
    await fs.link(backupPath, filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw new OperatorError('WRITE_RECOVERY_FAILED', 'Could not restore the claimed file after a failed replacement.');
    }
  } finally {
    await fs.rm(backupPath, { force: true });
  }
}


function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

async function assertMissing(target: string, message: string, expectMissing = false): Promise<void> {
  try {
    await fs.lstat(target);
    if (expectMissing) throw new OperatorError('FILE_MANAGE_POSTCONDITION_FAILED', message);
    throw new OperatorError('TARGET_EXISTS', message);
  } catch (error) {
    if (error instanceof OperatorError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
