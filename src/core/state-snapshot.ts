import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { OperatorError } from './errors.ts';
import { PERSISTENT_DATA_CATALOG, validatePersistentDataCatalog } from './persistent-data-catalog.ts';

const MAX_FILES = 50_000;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;

export interface SnapshotFile { path: string; bytes: number; sha256: string }
export interface SnapshotStore {
  id: string;
  location: string;
  present: boolean;
  revision: string;
  files: SnapshotFile[];
}
export interface SnapshotManifest {
  version: 1;
  epoch: string;
  createdAt: string;
  catalogDigest: string;
  stores: SnapshotStore[];
  manifestDigest: string;
}
export type SnapshotQuiescence = <T>(operation: () => Promise<T>) => Promise<T>;

export class StateSnapshotManager {
  #stateDir: string;
  #snapshotRoot: string;

  constructor(stateDir: string, snapshotRoot: string) {
    validatePersistentDataCatalog();
    this.#stateDir = path.resolve(stateDir);
    this.#snapshotRoot = path.resolve(snapshotRoot);
    if (inside(this.#stateDir, this.#snapshotRoot) || inside(this.#snapshotRoot, this.#stateDir) || this.#stateDir === this.#snapshotRoot) {
      throw new OperatorError('SNAPSHOT_PATH_INVALID', 'Snapshot storage and runtime state must be separate directory trees.');
    }
  }

  async create(input: {
    withQuiescence: SnapshotQuiescence;
    epoch?: string;
    signal?: AbortSignal;
    onFileCopied?: (count: number) => void | Promise<void>;
  }): Promise<SnapshotManifest> {
    const epoch = input.epoch ? validEpoch(input.epoch) : `${new Date().toISOString().replaceAll(':', '-')}-${crypto.randomUUID()}`;
    return await input.withQuiescence(async () => {
      throwIfAborted(input.signal);
      await fs.mkdir(this.#snapshotRoot, { recursive: true, mode: 0o700 });
      const finalDir = path.join(this.#snapshotRoot, epoch);
      const partialDir = path.join(this.#snapshotRoot, `.partial-${epoch}-${crypto.randomUUID()}`);
      if (await exists(finalDir)) throw new OperatorError('SNAPSHOT_EXISTS', 'Snapshot epoch already exists.');
      await fs.mkdir(path.join(partialDir, 'data'), { recursive: true, mode: 0o700 });
      let copied = 0;
      try {
        const stores: SnapshotStore[] = [];
        for (const catalog of snapshotCatalog()) {
          throwIfAborted(input.signal);
          const source = safeJoin(this.#stateDir, catalog.location);
          const files = await enumerate(source, catalog.location);
          const manifestFiles: SnapshotFile[] = [];
          for (const file of files) {
            throwIfAborted(input.signal);
            const destination = safeJoin(path.join(partialDir, 'data'), file.relative);
            await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
            await fs.copyFile(file.absolute, destination);
            manifestFiles.push({ path: file.relative, bytes: file.bytes, sha256: await sha256File(destination) });
            copied += 1;
            await input.onFileCopied?.(copied);
          }
          stores.push({
            id: catalog.id,
            location: catalog.location,
            present: await exists(source),
            revision: storeRevision(catalog.id, manifestFiles),
            files: manifestFiles
          });
        }
        const base = {
          version: 1 as const,
          epoch,
          createdAt: new Date().toISOString(),
          catalogDigest: catalogDigest(),
          stores
        };
        const manifest: SnapshotManifest = { ...base, manifestDigest: digestJson(base) };
        await fs.writeFile(path.join(partialDir, 'manifest.json'), JSON.stringify(manifest, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        await fs.rename(partialDir, finalDir);
        return manifest;
      } catch (error) {
        await fs.rm(partialDir, { recursive: true, force: true });
        throw error;
      }
    });
  }

  async verify(epochInput: string): Promise<SnapshotManifest> {
    const snapshotDir = path.join(this.#snapshotRoot, validEpoch(epochInput));
    const manifest = await readManifest(snapshotDir);
    validateManifestShape(manifest);
    if (manifest.catalogDigest !== catalogDigest()) throw new OperatorError('SNAPSHOT_CATALOG_MISMATCH', 'Snapshot was created for a different persistent-data catalog.');
    const base = { version: manifest.version, epoch: manifest.epoch, createdAt: manifest.createdAt, catalogDigest: manifest.catalogDigest, stores: manifest.stores };
    if (manifest.manifestDigest !== digestJson(base)) throw new OperatorError('SNAPSHOT_MANIFEST_TAMPERED', 'Snapshot manifest digest does not match its contents.');
    const expectedIds = snapshotCatalog().map((item) => item.id).sort();
    if (manifest.stores.map((item) => item.id).sort().join('\0') !== expectedIds.join('\0')) throw new OperatorError('SNAPSHOT_INCOMPLETE', 'Snapshot manifest does not cover every participating store.');
    for (const store of manifest.stores) {
      if (store.revision !== storeRevision(store.id, store.files)) throw new OperatorError('SNAPSHOT_STORE_TAMPERED', `Snapshot store ${store.id} revision is invalid.`);
      for (const file of store.files) {
        const target = safeJoin(path.join(snapshotDir, 'data'), file.path);
        const stat = await safeFileStat(target);
        if (stat.size !== file.bytes || await sha256File(target) !== file.sha256) throw new OperatorError('SNAPSHOT_FILE_TAMPERED', `Snapshot file ${file.path} failed digest verification.`);
      }
    }
    return structuredClone(manifest);
  }

  async restore(input: { epoch: string; withQuiescence: SnapshotQuiescence; signal?: AbortSignal; onStoreRestored?: (count: number) => void | Promise<void> }): Promise<SnapshotManifest> {
    const manifest = await this.verify(input.epoch);
    return await input.withQuiescence(async () => {
      throwIfAborted(input.signal);
      const snapshotDir = path.join(this.#snapshotRoot, manifest.epoch);
      const transaction = path.join(path.dirname(this.#stateDir), `.mecord-restore-${crypto.randomUUID()}`);
        const staged = path.join(transaction, 'staged');
      const rollback = path.join(transaction, 'rollback');
      await fs.mkdir(staged, { recursive: true, mode: 0o700 });
      const moved: Array<{ target: string; rollbackTarget?: string }> = [];
      let restored = 0;
      try {
        for (const store of manifest.stores) {
          const isDirectory = store.present && !store.files.some((file) => file.path === store.location);
          if (isDirectory) await fs.mkdir(safeJoin(staged, store.location), { recursive: true, mode: 0o700 });
          for (const file of store.files) {
            const source = safeJoin(path.join(snapshotDir, 'data'), file.path);
            const destination = safeJoin(staged, file.path);
            await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
            await fs.copyFile(source, destination);
          }
        }
        throwIfAborted(input.signal);
        for (const store of manifest.stores) {
          const target = safeJoin(this.#stateDir, store.location);
          await assertNoSymlink(target);
          let rollbackTarget: string | undefined;
          if (await exists(target)) {
            rollbackTarget = safeJoin(rollback, store.location);
            await fs.mkdir(path.dirname(rollbackTarget), { recursive: true, mode: 0o700 });
            await fs.rename(target, rollbackTarget);
          }
          moved.push({ target, ...(rollbackTarget ? { rollbackTarget } : {}) });
          if (store.present) {
            const source = safeJoin(staged, store.location);
            await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
            await fs.rename(source, target);
          }
          restored += 1;
          await input.onStoreRestored?.(restored);
          throwIfAborted(input.signal);
        }
        await fs.rm(transaction, { recursive: true, force: true });
        return manifest;
      } catch (error) {
        for (const item of moved.reverse()) {
          await fs.rm(item.target, { recursive: true, force: true }).catch(() => undefined);
          if (item.rollbackTarget && await exists(item.rollbackTarget)) {
            await fs.mkdir(path.dirname(item.target), { recursive: true, mode: 0o700 });
            await fs.rename(item.rollbackTarget, item.target).catch(() => undefined);
          }
        }
        await fs.rm(transaction, { recursive: true, force: true });
        throw error;
      }
    });
  }
}

function snapshotCatalog() {
  return PERSISTENT_DATA_CATALOG.filter((item) => item.backup === 'include' && item.restore !== 'never');
}
function catalogDigest(): string { return digestJson(snapshotCatalog().map(({ id, location, restore }) => ({ id, location, restore }))); }
function storeRevision(id: string, files: SnapshotFile[]): string { return digestJson({ id, files: files.slice().sort((a, b) => a.path.localeCompare(b.path)) }); }
function digestJson(value: unknown): string { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

async function enumerate(target: string, relative: string): Promise<Array<{ absolute: string; relative: string; bytes: number }>> {
  if (!await exists(target)) return [];
  const stat = await fs.lstat(target);
  if (stat.isSymbolicLink()) throw new OperatorError('SNAPSHOT_SYMLINK_REJECTED', 'Snapshot source must not contain symbolic links.');
  if (stat.isFile()) return [{ absolute: target, relative, bytes: stat.size }];
  if (!stat.isDirectory()) throw new OperatorError('SNAPSHOT_SOURCE_INVALID', 'Snapshot source contains a special file.');
  const result: Array<{ absolute: string; relative: string; bytes: number }> = [];
  for (const name of (await fs.readdir(target)).sort()) {
    result.push(...await enumerate(path.join(target, name), `${relative}/${name}`));
    if (result.length > MAX_FILES) throw new OperatorError('SNAPSHOT_LIMIT', 'Snapshot exceeds the bounded file count.');
  }
  return result;
}

async function sha256File(file: string): Promise<string> {
  const handle = await fs.open(file, 'r');
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(256 * 1024);
  try {
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally { await handle.close(); }
  return hash.digest('hex');
}

async function readManifest(snapshotDir: string): Promise<SnapshotManifest> {
  try {
    const text = await fs.readFile(path.join(snapshotDir, 'manifest.json'), 'utf8');
    if (Buffer.byteLength(text) > MAX_MANIFEST_BYTES) throw new Error('too large');
    return JSON.parse(text) as SnapshotManifest;
  } catch (error) {
    if (error instanceof OperatorError) throw error;
    throw new OperatorError('SNAPSHOT_MANIFEST_INVALID', 'Snapshot manifest is missing or invalid.');
  }
}

function validateManifestShape(manifest: SnapshotManifest): void {
  if (!manifest || manifest.version !== 1 || validEpoch(manifest.epoch) !== manifest.epoch || !Number.isFinite(Date.parse(manifest.createdAt)) || !Array.isArray(manifest.stores)) throw new OperatorError('SNAPSHOT_MANIFEST_INVALID', 'Snapshot manifest shape is invalid.');
  if (!/^[0-9a-f]{64}$/.test(manifest.catalogDigest) || !/^[0-9a-f]{64}$/.test(manifest.manifestDigest)) throw new OperatorError('SNAPSHOT_MANIFEST_INVALID', 'Snapshot manifest digests are invalid.');
  for (const store of manifest.stores) {
    if (!store || typeof store.id !== 'string' || typeof store.location !== 'string' || typeof store.present !== 'boolean' || !/^[0-9a-f]{64}$/.test(store.revision) || !Array.isArray(store.files)) throw new OperatorError('SNAPSHOT_MANIFEST_INVALID', 'Snapshot store entry is invalid.');
    if (!store.present && store.files.length > 0) throw new OperatorError('SNAPSHOT_MANIFEST_INVALID', 'Absent snapshot stores cannot contain files.');
    for (const file of store.files) {
      if (!file || typeof file.path !== 'string' || !(file.path === store.location || file.path.startsWith(`${store.location}/`)) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[0-9a-f]{64}$/.test(file.sha256)) throw new OperatorError('SNAPSHOT_MANIFEST_INVALID', 'Snapshot file entry is invalid.');
    }
  }
}

function validEpoch(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value)) throw new OperatorError('SNAPSHOT_EPOCH_INVALID', 'Snapshot epoch is invalid.');
  return value;
}
function safeJoin(root: string, relative: string): string {
  const target = path.resolve(root, relative);
  const rel = path.relative(root, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new OperatorError('SNAPSHOT_PATH_INVALID', 'Snapshot path escaped its root.');
  return target;
}
function inside(parent: string, child: string): boolean { const rel = path.relative(parent, child); return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel); }
async function exists(target: string): Promise<boolean> { try { await fs.lstat(target); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }
async function safeFileStat(target: string) { const stat = await fs.lstat(target); if (!stat.isFile() || stat.isSymbolicLink()) throw new OperatorError('SNAPSHOT_FILE_INVALID', 'Snapshot payload must contain regular files only.'); return stat; }
async function assertNoSymlink(target: string): Promise<void> { if (!await exists(target)) return; const stat = await fs.lstat(target); if (stat.isSymbolicLink()) throw new OperatorError('SNAPSHOT_SYMLINK_REJECTED', 'Restore target must not be a symbolic link.'); }
function throwIfAborted(signal?: AbortSignal): void { if (signal?.aborted) throw new OperatorError('SNAPSHOT_ABORTED', 'Snapshot operation was interrupted.', { retryable: true }); }
