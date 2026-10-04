import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { ActionRequest, ActionResult, ActionRisk, CapabilityProvider, CapabilityScore, ProviderReconciliationResult } from '../core/types.ts';
import { evidence } from '../core/evidence.ts';
import { OperatorError } from '../core/errors.ts';
import { PathScope } from './path-scope.ts';

function sha256(buffer: Uint8Array): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

type StableFileIdentity = {
  device: string;
  inode: string;
  links: string;
  size: number;
  modifiedNs: string;
  changedNs: string;
  createdNs: string;
  digest: string;
};

async function stableFileObservation(
  filePath: string,
  maxBytes: number,
  hook?: (filePath: string, phase: 'opened' | 'before-verify') => Promise<void> | void
): Promise<{ stat: Awaited<ReturnType<Awaited<ReturnType<typeof fs.open>>['stat']>>; bytes: Buffer; identity: StableFileIdentity }> {
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await fs.open(filePath, flags);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new OperatorError('NOT_A_FILE', 'Requested path is not a regular file.');
    if (before.size > BigInt(maxBytes)) throw new OperatorError('READ_TOO_LARGE', `File exceeds ${maxBytes} byte read limit.`, { details: { size: before.size.toString() } });
    await hook?.(filePath, 'opened');
    const first = await readHandleExactly(handle, Number(before.size));
    await hook?.(filePath, 'before-verify');
    const second = await readHandleExactly(handle, Number(before.size));
    const after = await handle.stat({ bigint: true });
    const pathState = await fs.stat(filePath, { bigint: true });
    const stableMetadata = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'birthtimeNs'].every((key) => before[key as keyof typeof before] === after[key as keyof typeof after]);
    const samePathIdentity = process.platform === 'win32'
      ? before.ino === pathState.ino && before.birthtimeNs === pathState.birthtimeNs
      : before.dev === pathState.dev && before.ino === pathState.ino;
    const completeRead = first.byteLength === Number(before.size) && second.byteLength === Number(before.size);
    const sameBytes = first.equals(second);
    if (!stableMetadata || !samePathIdentity || !completeRead || !sameBytes) {
      throw new OperatorError('FILE_OBSERVATION_CHANGED', 'File identity or bytes changed during stable observation; retry from a fresh precondition.', {
        retryable: true,
        details: { sideEffectState: 'none', executionPhase: 'pre_dispatch', stableMetadata, samePathIdentity, completeRead, sameBytes }
      });
    }
    const identityBase = {
      device: before.dev.toString(), inode: before.ino.toString(), links: before.nlink.toString(), size: Number(before.size),
      modifiedNs: before.mtimeNs.toString(), changedNs: before.ctimeNs.toString(), createdNs: before.birthtimeNs.toString()
    };
    const identity = { ...identityBase, digest: sha256(Buffer.from(JSON.stringify(identityBase), 'utf8')) };
    return { stat: await handle.stat(), bytes: first, identity };
  } finally {
    await handle.close();
  }
}

async function readHandleExactly(handle: Awaited<ReturnType<typeof fs.open>>, size: number): Promise<Buffer> {
  const output = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const read = await handle.read(output, offset, size - offset, offset);
    if (read.bytesRead === 0) break;
    offset += read.bytesRead;
  }
  return output.subarray(0, offset);
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
  #observationHook?: (filePath: string, phase: 'opened' | 'before-verify') => Promise<void> | void;

  constructor(options: {
    allowedRoots: string[];
    maxReadBytes?: number;
    maxWriteBytes?: number;
    replaceClaimHook?: (filePath: string) => Promise<void> | void;
    pathLeaseHook?: (capability: string, filePath: string) => Promise<void> | void;
    observationHook?: (filePath: string, phase: 'opened' | 'before-verify') => Promise<void> | void;
    windowsPathLeaseExecutable?: string;
  }) {
    this.#scope = new PathScope(options.allowedRoots, { windowsPathLeaseExecutable: options.windowsPathLeaseExecutable });
    this.#maxReadBytes = boundedBytes(options.maxReadBytes, DEFAULT_MAX_READ_BYTES);
    this.#maxWriteBytes = boundedBytes(options.maxWriteBytes, DEFAULT_MAX_WRITE_BYTES);
    this.#replaceClaimHook = options.replaceClaimHook;
    this.#pathLeaseHook = options.pathLeaseHook;
    this.#observationHook = options.observationHook;
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
        error: {
          code: op.code, message: op.message, retryable: op.retryable,
          ...(op.details && ['none', 'known', 'uncertain'].includes(String(op.details.sideEffectState)) ? { sideEffectState: op.details.sideEffectState as 'none' | 'known' | 'uncertain' } : {}),
          ...(op.details && ['pre_dispatch', 'dispatched', 'effect_observed', 'reconciled'].includes(String(op.details.executionPhase)) ? { executionPhase: op.details.executionPhase as 'pre_dispatch' | 'dispatched' | 'effect_observed' | 'reconciled' } : {}),
          ...(op.details ? { details: structuredClone(op.details) } : {})
        },
        durationMs: Math.round(performance.now() - started)
      };
    }
  }

  async reconcile({ action }: { action: ActionRequest; priorResult?: ActionResult }): Promise<ProviderReconciliationResult> {
    if (['file.write', 'file.create', 'file.replace'].includes(action.capability)) {
      const requested = requiredString(action.input.path, 'path');
      if (typeof action.input.content !== 'string') return reconciliation('uncertain', 'File write content is unavailable for reconciliation.');
      const expectedSha = sha256(Buffer.from(action.input.content, 'utf8'));
      try {
        return await this.#scope.withExisting(requested, async (filePath) => {
          await this.#pathLeaseHook?.(action.capability, filePath);
          const stat = await fs.lstat(filePath);
          if (!stat.isFile() || stat.isSymbolicLink()) return reconciliation('uncertain', 'Write target is not a regular file during reconciliation.');
          const actualSha = sha256(await fs.readFile(filePath));
          if (actualSha !== expectedSha) return reconciliation('not_applied', 'Current file bytes do not match the requested write.');
          const result: ActionResult = {
            ok: true,
            capability: action.capability,
            provider: this.name,
            output: { path: filePath, afterSha256: actualSha, reconciled: true },
            evidence: [evidence('filesystem_reconciliation', 'pass', 'Current file bytes prove the requested write is present.', { afterSha256: actualSha })],
            durationMs: 0
          };
          return { status: 'completed', result, evidence: result.evidence };
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error instanceof OperatorError && error.code === 'TARGET_MISSING')) {
          return reconciliation('not_applied', 'Write target is absent during reconciliation.');
        }
        throw error;
      }
    }

    if (action.capability === 'file.manage') {
      const operation = String(action.input.operation ?? '');
      if (operation === 'mkdir') {
        const requested = requiredString(action.input.path, 'path');
        try {
          return await this.#scope.withExisting(requested, async (target) => {
            const stat = await fs.lstat(target);
            return stat.isDirectory() && !stat.isSymbolicLink()
              ? reconciliation('completed', 'Requested directory exists after uncertain execution.', action, this.name)
              : reconciliation('uncertain', 'Requested mkdir target exists but is not a real directory.');
          });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error instanceof OperatorError && error.code === 'TARGET_MISSING')) {
            return reconciliation('not_applied', 'Requested directory does not exist.');
          }
          throw error;
        }
      }
      if (operation === 'remove') {
        const requested = requiredString(action.input.path, 'path');
        try {
          await this.#scope.withExisting(requested, async () => undefined);
          return reconciliation('not_applied', 'Remove target still exists.');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error instanceof OperatorError && error.code === 'TARGET_MISSING')) {
            return reconciliation('completed', 'Remove target is absent after uncertain execution.', action, this.name);
          }
          throw error;
        }
      }
      if (operation === 'copy' || operation === 'move') {
        const sourceInput = requiredString(action.input.source, 'source');
        const destinationInput = requiredString(action.input.destination, 'destination');
        const source = await pathSnapshot(this.#scope, sourceInput);
        const destination = await pathSnapshot(this.#scope, destinationInput);
        if (operation === 'copy') {
          if (!destination.exists) return reconciliation('not_applied', 'Copy destination is absent.');
          if (source.exists && source.sha256 && destination.sha256 === source.sha256) {
            return reconciliation('completed', 'Copy destination matches current source bytes.', action, this.name);
          }
          return reconciliation('uncertain', 'Copy destination cannot be proven to match the source.');
        }
        if (!source.exists && destination.exists) {
          return reconciliation('completed', 'Move source is absent and destination exists.', action, this.name);
        }
        if (source.exists && !destination.exists) return reconciliation('not_applied', 'Move source remains and destination is absent.');
        return reconciliation('uncertain', 'Move state is ambiguous and requires explicit review.');
      }
    }
    return reconciliation('uncertain', 'Filesystem provider has no reconciliation contract for this action.');
  }

  async #read(action: ActionRequest, started: number): Promise<ActionResult> {
    const requested = requiredString(action.input.path, 'path');
    return await this.#scope.withExisting(requested, async (filePath) => {
      await this.#pathLeaseHook?.(action.capability, filePath);
      const snapshot = await stableFileObservation(filePath, this.#maxReadBytes, this.#observationHook);
      const { stat, bytes: fullBytes, identity } = snapshot;
      const encoding = action.input.encoding === 'base64' ? 'base64' : 'utf8';
      const offset = boundedInteger(action.input.offset, 0, 0, Math.max(0, stat.size));
      const maxBytes = boundedInteger(action.input.maxBytes, 48 * 1024, 1024, encoding === 'base64' ? 96 * 1024 : 128 * 1024);
      const returnedBytes = Math.min(maxBytes, Math.max(0, stat.size - offset));
      const data = fullBytes.subarray(offset, offset + returnedBytes);
      const digest = sha256(fullBytes);
      const nextOffset = offset + returnedBytes;
      return {
        ok: true,
        capability: action.capability,
        provider: this.name,
        output: { path: filePath, size: stat.size, sha256: digest, identity, offset, returnedBytes, content: data.toString(encoding), truncated: nextOffset < stat.size, ...(nextOffset < stat.size ? { nextOffset } : {}) },
        evidence: [evidence('file_read', 'pass', 'A stable, handle-bound file snapshot was read from authorized scope.', { path: filePath, size: stat.size, offset, returnedBytes, sha256: digest, identityDigest: identity.digest })],
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
      const offset = boundedInteger(action.input.offset, 0, 0, 1_000_000);
      const limit = boundedInteger(action.input.limit, 500, 1, 500);
      const entries = (await fs.readdir(dirPath, { withFileTypes: true }))
        .sort((left, right) => left.name.localeCompare(right.name));
      const bounded = entries.slice(offset, offset + limit).map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : entry.isSymbolicLink() ? 'symlink' : 'other'
      }));
      const nextOffset = offset + bounded.length;
      const truncated = nextOffset < entries.length;
      return {
        ok: true,
        capability: action.capability,
        provider: this.name,
        output: { path: dirPath, entries: bounded, offset, limit, total: entries.length, truncated, ...(truncated ? { nextOffset } : {}) },
        evidence: [evidence('directory_list', 'pass', 'Directory page listed deterministically from authorized scope.', { path: dirPath, count: bounded.length, offset, total: entries.length })],
        durationMs: Math.round(performance.now() - started)
      };
    });
  }

  async #info(action: ActionRequest, started: number): Promise<ActionResult> {
    const requested = requiredString(action.input.path, 'path');
    return await this.#scope.withExisting(requested, async (resolved) => {
      await this.#pathLeaseHook?.(action.capability, resolved);
      const lstat = await fs.lstat(resolved);
      if (lstat.isSymbolicLink()) throw new OperatorError('FILE_OBSERVATION_SYMLINK_DENIED', 'Stable file observation refuses symbolic links.');
      const stable = lstat.isFile() && lstat.size <= this.#maxReadBytes
        ? await stableFileObservation(resolved, this.#maxReadBytes, this.#observationHook)
        : undefined;
      const stat = stable?.stat ?? lstat;
      const output: Record<string, unknown> = {
        path: resolved,
        type: stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'other',
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        createdAt: stat.birthtime.toISOString(),
        mode: stat.mode,
        ...(stable ? { identity: stable.identity } : {})
      };
      if (stable) output.sha256 = sha256(stable.bytes);
      return {
        ok: true, capability: action.capability, provider: this.name, output,
        evidence: [evidence('file_info', 'pass', stable ? 'Filesystem metadata and bytes were captured from one stable handle-bound identity.' : 'Filesystem metadata inspected inside authorized scope.', { path: resolved, type: output.type, size: stat.size, ...(stable ? { identityDigest: stable.identity.digest } : {}) })],
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
      return await this.#scope.withExisting(sourceInput, async (source) => await this.#scope.withForWrite(destinationInput, async (destination) => {
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
      const expectedSha = normalizeExpectedSha(action.input.expectedSha256);

      const staged = await this.#scope.withExisting(sourceInput, async (source) => {
        await this.#pathLeaseHook?.(action.capability, source);
        const sourceStat = await fs.lstat(source);
        if (sourceStat.isSymbolicLink()) throw new OperatorError('FILE_MOVE_SYMLINK_DENIED', 'Refusing to move a symbolic link.');
        if (!sourceStat.isFile() && !sourceStat.isDirectory()) throw new OperatorError('FILE_MOVE_TYPE_DENIED', 'Move supports regular files and empty directories only.');

        if (sourceStat.isFile()) {
          if (!expectedSha) throw new OperatorError('PRECONDITION_REQUIRED', 'Moving a file requires expectedSha256 from a fresh file.info or file.read.');
          const sourceBytes = await fs.readFile(source);
          const actualSha = sha256(sourceBytes);
          if (actualSha !== expectedSha) throw new OperatorError('PRECONDITION_FAILED', 'Move source changed since it was inspected.', { details: { expectedSha, actualSha } });
          const destination = await this.#scope.withForWrite(destinationInput, async (target) => {
            await this.#pathLeaseHook?.(action.capability, target);
            await assertMissing(target, 'Move destination already exists.');
            await fs.copyFile(source, target, fs.constants.COPYFILE_EXCL);
            const copied = await fs.readFile(target);
            const copiedSha = sha256(copied);
            if (copiedSha !== expectedSha) {
              await fs.rm(target, { force: true });
              throw new OperatorError('FILE_MANAGE_POSTCONDITION_FAILED', 'Staged move destination hash does not match the inspected source.');
            }
            return target;
          });
          return { type: 'file' as const, source, destination, sourceBytes, sha256: expectedSha };
        }

        const entries = await fs.readdir(source);
        if (entries.length !== 0) throw new OperatorError('FILE_MOVE_DIRECTORY_NOT_EMPTY', 'Directory move is currently limited to empty directories.');
        const destination = await this.#scope.withForWrite(destinationInput, async (target) => {
          await this.#pathLeaseHook?.(action.capability, target);
          await assertMissing(target, 'Move destination already exists.');
          await fs.mkdir(target);
          return target;
        });
        return { type: 'directory' as const, source, destination };
      });

      try {
        await this.#scope.withForWrite(sourceInput, async (source) => {
          await this.#pathLeaseHook?.(action.capability, source);
          const current = await fs.lstat(source);
          if (current.isSymbolicLink()) throw new OperatorError('FILE_MOVE_SYMLINK_DENIED', 'Move source became a symbolic link before removal.');
          if (staged.type === 'file') {
            if (!current.isFile()) throw new OperatorError('PRECONDITION_FAILED', 'Move source type changed before removal.');
            const currentSha = sha256(await fs.readFile(source));
            if (currentSha !== staged.sha256) throw new OperatorError('PRECONDITION_FAILED', 'Move source changed after destination staging.', { details: { expectedSha: staged.sha256, actualSha: currentSha } });
            await fs.rm(source);
          } else {
            if (!current.isDirectory() || (await fs.readdir(source)).length !== 0) throw new OperatorError('PRECONDITION_FAILED', 'Move source directory changed after destination staging.');
            await fs.rmdir(source);
          }
          await assertMissing(source, 'Move source still exists after removal.', true);
        });
      } catch (error) {
        // Source remains authoritative when removal fails. Remove only the destination
        // we just staged, and only when it still matches our own staged state.
        try {
          await this.#scope.withForWrite(destinationInput, async (destination) => {
            await this.#pathLeaseHook?.(action.capability, destination);
            const stat = await fs.lstat(destination);
            if (staged.type === 'file' && stat.isFile() && sha256(await fs.readFile(destination)) === staged.sha256) await fs.rm(destination);
            else if (staged.type === 'directory' && stat.isDirectory() && (await fs.readdir(destination)).length === 0) await fs.rmdir(destination);
          });
        } catch {}
        throw error;
      }

      if (staged.type === 'file') {
        const verified = await this.#scope.withExisting(destinationInput, async (destination) => {
          await this.#pathLeaseHook?.(action.capability, destination);
          const stat = await fs.lstat(destination);
          if (!stat.isFile() || stat.isSymbolicLink()) throw new OperatorError('FILE_MANAGE_POSTCONDITION_FAILED', 'Move destination is no longer a regular file.');
          return { destination, sha256: sha256(await fs.readFile(destination)) };
        });
        if (verified.sha256 !== staged.sha256) {
          // Best-effort source restoration is create-only; never overwrite a concurrent recreation.
          try {
            await this.#scope.withForWrite(sourceInput, async (source) => {
              await this.#pathLeaseHook?.(action.capability, source);
              await assertMissing(source, 'Move source was concurrently recreated.');
              await fs.writeFile(source, staged.sourceBytes, { flag: 'wx' });
            });
          } catch {}
          throw new OperatorError('FILE_MANAGE_POSTCONDITION_FAILED', 'Move destination changed before final verification.');
        }
        return {
          ok: true, capability: action.capability, provider: this.name,
          output: { operation, source: staged.source, destination: verified.destination, type: 'file', sha256: staged.sha256 },
          evidence: [evidence('file_move', 'pass', 'File move completed as verified stage-copy then fresh-precondition source removal.', { source: staged.source, destination: verified.destination, sha256: staged.sha256 })],
          durationMs: Math.round(performance.now() - started)
        };
      }

      const verifiedDirectory = await this.#scope.withExisting(destinationInput, async (destination) => {
        await this.#pathLeaseHook?.(action.capability, destination);
        const stat = await fs.lstat(destination);
        if (!stat.isDirectory() || stat.isSymbolicLink() || (await fs.readdir(destination)).length !== 0) {
          throw new OperatorError('FILE_MANAGE_POSTCONDITION_FAILED', 'Moved empty directory did not remain an empty real directory.');
        }
        return destination;
      });
      return {
        ok: true, capability: action.capability, provider: this.name,
        output: { operation, source: staged.source, destination: verifiedDirectory, type: 'directory' },
        evidence: [evidence('file_move', 'pass', 'Empty directory move completed through verified create/remove semantics.', { source: staged.source, destination: verifiedDirectory })],
        durationMs: Math.round(performance.now() - started)
      };
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

function reconciliation(
  status: ProviderReconciliationResult['status'],
  message: string,
  action?: ActionRequest,
  provider = 'filesystem.native'
): ProviderReconciliationResult {
  const item = evidence('filesystem_reconciliation', status === 'completed' ? 'pass' : 'info', message);
  if (status !== 'completed' || !action) return { status, evidence: [item] };
  const result: ActionResult = {
    ok: true,
    capability: action.capability,
    provider,
    output: { reconciled: true },
    evidence: [item],
    durationMs: 0
  };
  return { status, result, evidence: result.evidence };
}

async function pathSnapshot(scope: PathScope, requested: string): Promise<{ exists: boolean; sha256?: string }> {
  try {
    return await scope.withExisting(requested, async (target) => {
      const stat = await fs.lstat(target);
      if (stat.isSymbolicLink()) return { exists: true };
      if (stat.isFile()) return { exists: true, sha256: sha256(await fs.readFile(target)) };
      return { exists: true };
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error instanceof OperatorError && error.code === 'TARGET_MISSING')) {
      return { exists: false };
    }
    throw error;
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
