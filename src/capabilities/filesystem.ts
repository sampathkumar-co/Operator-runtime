import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { ActionRequest, ActionResult, CapabilityProvider, CapabilityScore } from '../core/types.ts';
import { evidence } from '../core/evidence.ts';
import { OperatorError } from '../core/errors.ts';
import { PathScope } from './path-scope.ts';

function sha256(buffer: Uint8Array): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

const DEFAULT_MAX_READ_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_WRITE_BYTES = 2 * 1024 * 1024;
const MAX_CONFIGURED_IO_BYTES = 64 * 1024 * 1024;

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
    return ['file.read', 'file.list', 'file.write', 'file.create', 'file.replace'].includes(action.capability);
  }

  score(): CapabilityScore { return SCORE; }

  async execute(action: ActionRequest): Promise<ActionResult> {
    const started = performance.now();
    try {
      if (action.capability === 'file.read') return await this.#read(action, started);
      if (action.capability === 'file.list') return await this.#list(action, started);
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
