import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { OperatorError } from './errors.ts';
import { readDurableStateText, writeDurableStateText } from './durable-state.ts';
import { PERSISTENT_DATA_CATALOG, isMonotonicRestoreStore, validatePersistentDataCatalog } from './persistent-data-catalog.ts';

const MAX_FILES = 50_000;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const RESTORE_TRANSACTION_PREFIX = '.mecord-restore-';
const RESTORE_TRANSACTION_FILE = 'restore-transaction.json';
const RESTORE_TRANSACTION_OPTIONS = {
  maxBytes: 2 * 1024 * 1024,
  errorCode: 'SNAPSHOT_RESTORE_TRANSACTION_CORRUPT',
  invalidMessage: 'Snapshot restore transaction is invalid.'
} as const;

interface RestoreTransactionStore {
  targetLocation: string;
  hadOriginal: boolean;
  snapshotPresent: boolean;
}
interface RestoreTransactionBody {
  version: 1;
  stateDir: string;
  epoch: string;
  manifestDigest: string;
  phase: 'PREPARED' | 'COMMITTED';
  stores: RestoreTransactionStore[];
  createdAt: string;
  updatedAt: string;
}
interface RestoreTransactionRecord extends RestoreTransactionBody {
  recordDigest: string;
}

export interface SnapshotFile { path: string; bytes: number; sha256: string }
export interface SnapshotStore {
  id: string;
  location: string;
  present: boolean;
  revision: string;
  files: SnapshotFile[];
}
export interface SnapshotManifest {
  version: 2;
  epoch: string;
  createdAt: string;
  catalogDigest: string;
  authorityDigest: string;
  stores: SnapshotStore[];
  signerKeyId: string;
  manifestDigest: string;
  signature: string;
}
export interface SnapshotAuthenticator {
  keyId: string;
  sign(payload: Uint8Array): Promise<string>;
  verify(payload: Uint8Array, signature: string): Promise<boolean>;
}
export interface SnapshotCatalogMigrationPlan {
  id: string;
  fromCatalogDigest: string;
  toCatalogDigest: string;
  stores: Array<{ targetId: string; sourceId?: string }>;
}
export type SnapshotQuiescence = <T>(operation: () => Promise<T>) => Promise<T>;

export class StateSnapshotManager {
  #stateDir: string;
  #snapshotRoot: string;
  #catalogMigrations: SnapshotCatalogMigrationPlan[];
  #authenticator: SnapshotAuthenticator;

  constructor(stateDir: string, snapshotRoot: string, options: { authenticator: SnapshotAuthenticator; catalogMigrations?: SnapshotCatalogMigrationPlan[] }) {
    validatePersistentDataCatalog();
    this.#stateDir = path.resolve(stateDir);
    this.#snapshotRoot = path.resolve(snapshotRoot);
    this.#catalogMigrations = structuredClone(options.catalogMigrations ?? []);
    this.#authenticator = normalizeAuthenticator(options.authenticator);
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
        const unsigned = {
          version: 2 as const,
          epoch,
          createdAt: new Date().toISOString(),
          catalogDigest: catalogDigest(),
          authorityDigest: authorityDigestFromStores(stores),
          stores,
          signerKeyId: this.#authenticator.keyId
        };
        const manifestDigest = digestJson(unsigned);
        const signature = await this.#authenticator.sign(signaturePayload(manifestDigest, unsigned.signerKeyId));
        const manifest: SnapshotManifest = { ...unsigned, manifestDigest, signature: validSignature(signature) };
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
    const unsigned = {
      version: manifest.version, epoch: manifest.epoch, createdAt: manifest.createdAt,
      catalogDigest: manifest.catalogDigest, authorityDigest: manifest.authorityDigest,
      stores: manifest.stores, signerKeyId: manifest.signerKeyId
    };
    if (manifest.manifestDigest !== digestJson(unsigned)) throw new OperatorError('SNAPSHOT_MANIFEST_TAMPERED', 'Snapshot manifest digest does not match its contents.');
    if (manifest.authorityDigest !== authorityDigestFromStores(manifest.stores)) throw new OperatorError('SNAPSHOT_AUTHORITY_TAMPERED', 'Snapshot authority digest does not match its authority-bearing stores.');
    if (manifest.signerKeyId !== this.#authenticator.keyId || !await this.#authenticator.verify(signaturePayload(manifest.manifestDigest, manifest.signerKeyId), manifest.signature)) {
      throw new OperatorError('SNAPSHOT_SIGNATURE_INVALID', 'Snapshot manifest is not authenticated by the current device authority.');
    }
    this.#resolveRestoreStores(manifest);
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
    const restoreStores = this.#resolveRestoreStores(manifest).filter((store) => !isMonotonicRestoreStore(store.targetId));
    return await input.withQuiescence(async () => {
      throwIfAborted(input.signal);
      await recoverPendingSnapshotRestores(this.#stateDir);

      const liveAuthorityDigest = await authorityDigestForState(this.#stateDir);
      if (liveAuthorityDigest !== manifest.authorityDigest) {
        throw new OperatorError('SNAPSHOT_AUTHORITY_STALE', 'Restore refused because live authority changed after this snapshot; historical authority cannot replace or bypass the newer state.', {
          retryable: false,
          details: { snapshotAuthorityDigest: manifest.authorityDigest, liveAuthorityDigest }
        });
      }

      const snapshotDir = path.join(this.#snapshotRoot, manifest.epoch);
      const transaction = path.join(path.dirname(this.#stateDir), `${restoreTransactionPrefix(this.#stateDir)}${crypto.randomUUID()}`);
      const staged = path.join(transaction, 'staged');
      const rollback = path.join(transaction, 'rollback');
      await fs.mkdir(staged, { recursive: true, mode: 0o700 });
      let transactionBody: RestoreTransactionBody | undefined;
      let restored = 0;

      try {
        // Stage and re-hash the exact bytes that will be published. This closes
        // the verify->restore TOCTOU window: a snapshot modified after verify()
        // can never become live state.
        for (const store of restoreStores) {
          const isDirectory = store.present && !store.files.some((file) => file.targetPath === store.targetLocation);
          if (isDirectory) await fs.mkdir(safeJoin(staged, store.targetLocation), { recursive: true, mode: 0o700 });
          for (const file of store.files) {
            throwIfAborted(input.signal);
            const source = safeJoin(path.join(snapshotDir, 'data'), file.sourcePath);
            const sourceStat = await safeFileStat(source);
            if (sourceStat.size !== file.bytes) {
              throw new OperatorError('SNAPSHOT_FILE_TAMPERED', `Snapshot file ${file.sourcePath} changed after verification.`);
            }
            const destination = safeJoin(staged, file.targetPath);
            await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
            await fs.copyFile(source, destination);
            const stagedStat = await safeFileStat(destination);
            if (stagedStat.size !== file.bytes || await sha256File(destination) !== file.sha256) {
              throw new OperatorError('SNAPSHOT_FILE_TAMPERED', `Snapshot file ${file.sourcePath} changed after verification.`);
            }
          }
        }

        throwIfAborted(input.signal);
        const transactionStores: RestoreTransactionStore[] = [];
        for (const store of restoreStores) {
          const target = safeJoin(this.#stateDir, store.targetLocation);
          await assertNoSymlink(target);
          transactionStores.push({
            targetLocation: store.targetLocation,
            hadOriginal: await exists(target),
            snapshotPresent: store.present
          });
        }
        const now = new Date().toISOString();
        transactionBody = {
          version: 1,
          stateDir: this.#stateDir,
          epoch: manifest.epoch,
          manifestDigest: manifest.manifestDigest,
          phase: 'PREPARED',
          stores: transactionStores,
          createdAt: now,
          updatedAt: now
        };
        await writeRestoreTransaction(transaction, transactionBody);

        for (const store of restoreStores) {
          const target = safeJoin(this.#stateDir, store.targetLocation);
          const txStore = transactionStores.find((item) => item.targetLocation === store.targetLocation)!;
          if (txStore.hadOriginal) {
            const rollbackTarget = safeJoin(rollback, store.targetLocation);
            await fs.mkdir(path.dirname(rollbackTarget), { recursive: true, mode: 0o700 });
            await fs.rename(target, rollbackTarget);
          }
          if (store.present) {
            const source = safeJoin(staged, store.targetLocation);
            await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
            await fs.rename(source, target);
          }
          restored += 1;
          await input.onStoreRestored?.(restored);
          throwIfAborted(input.signal);
        }

        transactionBody = { ...transactionBody, phase: 'COMMITTED', updatedAt: new Date().toISOString() };
        await writeRestoreTransaction(transaction, transactionBody);
        // Once COMMITTED is durable, cleanup failure is not a restore failure.
        // Startup recovery will remove committed transaction debris without rollback.
        await fs.rm(transaction, { recursive: true, force: true }).catch(() => undefined);
        return manifest;
      } catch (error) {
        if (!transactionBody) {
          await fs.rm(transaction, { recursive: true, force: true });
          throw error;
        }
        try {
          await recoverRestoreTransaction(transaction, this.#stateDir);
        } catch (rollbackError) {
          throw new OperatorError('SNAPSHOT_ROLLBACK_INCOMPLETE', 'Snapshot restore failed and durable rollback could not fully recover the prior state. Recovery evidence was preserved.', {
            retryable: false,
            details: {
              transaction,
              originalError: error instanceof Error ? error.message : String(error),
              rollbackError: rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
            }
          });
        }
        throw error;
      }
    });
  }

  #resolveRestoreStores(manifest: SnapshotManifest): Array<{
    targetId: string;
    targetLocation: string;
    present: boolean;
    files: Array<{ sourcePath: string; targetPath: string; bytes: number; sha256: string }>;
  }> {
    const current = snapshotCatalog();
    const currentDigest = catalogDigest();
    let mappings: Array<{ targetId: string; sourceId?: string }>;
    if (manifest.catalogDigest === currentDigest) {
      const expectedIds = current.map((item) => item.id).sort();
      if (manifest.stores.map((item) => item.id).sort().join('\0') !== expectedIds.join('\0')) {
        throw new OperatorError('SNAPSHOT_INCOMPLETE', 'Snapshot manifest does not cover every participating store.');
      }
      mappings = current.map((item) => ({ targetId: item.id, sourceId: item.id }));
    } else {
      const migration = this.#catalogMigrations.find((candidate) =>
        candidate.fromCatalogDigest === manifest.catalogDigest && candidate.toCatalogDigest === currentDigest);
      if (!migration) {
        throw new OperatorError('SNAPSHOT_CATALOG_MISMATCH', 'Snapshot was created for a different persistent-data catalog and no exact migration plan is registered.');
      }
      boundedMigrationId(migration.id);
      if (!/^[0-9a-f]{64}$/.test(migration.fromCatalogDigest) || !/^[0-9a-f]{64}$/.test(migration.toCatalogDigest)
        || !Array.isArray(migration.stores)) {
        throw new OperatorError('SNAPSHOT_MIGRATION_INVALID', 'Snapshot catalog migration shape is invalid.');
      }
      if (migration.stores.some((mapping) => !mapping || typeof mapping !== 'object'
        || typeof mapping.targetId !== 'string'
        || (mapping.sourceId !== undefined && typeof mapping.sourceId !== 'string'))) {
        throw new OperatorError('SNAPSHOT_MIGRATION_INVALID', 'Snapshot catalog migration store mapping is invalid.');
      }
      mappings = migration.stores;
      const targets = mappings.map((item) => item.targetId).sort();
      const expected = current.map((item) => item.id).sort();
      if (targets.join('\0') !== expected.join('\0') || new Set(targets).size !== targets.length) {
        throw new OperatorError('SNAPSHOT_MIGRATION_INVALID', 'Snapshot catalog migration must map every current store exactly once.');
      }
      const sources = mappings.flatMap((item) => item.sourceId ? [item.sourceId] : []);
      if (new Set(sources).size !== sources.length || sources.some((id) => !manifest.stores.some((store) => store.id === id))) {
        throw new OperatorError('SNAPSHOT_MIGRATION_INVALID', 'Snapshot catalog migration contains a missing or duplicate source store.');
      }
    }
    return mappings.map((mapping) => {
      const target = current.find((item) => item.id === mapping.targetId)!;
      const source = mapping.sourceId ? manifest.stores.find((item) => item.id === mapping.sourceId) : undefined;
      return {
        targetId: target.id,
        targetLocation: target.location,
        present: source?.present ?? false,
        files: (source?.files ?? []).map((file) => ({
          sourcePath: file.path,
          targetPath: file.path === source!.location
            ? target.location
            : `${target.location}/${file.path.slice(source!.location.length + 1)}`,
          bytes: file.bytes,
          sha256: file.sha256
        }))
      };
    });
  }
}

export async function recoverPendingSnapshotRestores(stateDirInput: string): Promise<{
  rolledBack: number;
  cleanedCommitted: number;
  discardedUnprepared: number;
}> {
  const stateDir = path.resolve(stateDirInput);
  const parent = path.dirname(stateDir);
  const prefix = restoreTransactionPrefix(stateDir);
  let entries;
  try { entries = await fs.readdir(parent, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { rolledBack: 0, cleanedCommitted: 0, discardedUnprepared: 0 };
    throw error;
  }

  let rolledBack = 0;
  let cleanedCommitted = 0;
  let discardedUnprepared = 0;
  for (const entry of entries) {
    // Only transactions created by the new state-directory-bound protocol can
    // be attributed to this runtime. Pre-upgrade UUID-only directories lack
    // enough durable identity to associate them with a specific state root.
    if (!entry.name.startsWith(prefix)) continue;
    if (!entry.isDirectory()) {
      throw new OperatorError('SNAPSHOT_RESTORE_TRANSACTION_CORRUPT', 'Snapshot restore transaction path is not a real directory.');
    }
    const transaction = path.join(parent, entry.name);
    const journalFile = path.join(transaction, RESTORE_TRANSACTION_FILE);
    if (!await exists(journalFile)) {
      // New-format restore never mutates live state before PREPARED is durable.
      await fs.rm(transaction, { recursive: true, force: true });
      discardedUnprepared += 1;
      continue;
    }
    const record = await readRestoreTransaction(transaction, stateDir);
    if (record.phase === 'COMMITTED') {
      await fs.rm(transaction, { recursive: true, force: true });
      cleanedCommitted += 1;
      continue;
    }
    await recoverRestoreTransaction(transaction, stateDir, record);
    rolledBack += 1;
  }
  return { rolledBack, cleanedCommitted, discardedUnprepared };
}

async function writeRestoreTransaction(transaction: string, body: RestoreTransactionBody): Promise<void> {
  const stat = await fs.lstat(transaction);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new OperatorError('SNAPSHOT_RESTORE_TRANSACTION_CORRUPT', 'Snapshot restore transaction path must be a real directory.');
  }
  const normalized = validateRestoreTransactionBody(body);
  const record: RestoreTransactionRecord = { ...normalized, recordDigest: digestJson(normalized) };
  await writeDurableStateText(
    path.join(transaction, RESTORE_TRANSACTION_FILE),
    JSON.stringify(record, null, 2),
    RESTORE_TRANSACTION_OPTIONS
  );
}

async function readRestoreTransaction(transaction: string, expectedStateDir: string): Promise<RestoreTransactionRecord> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readDurableStateText(path.join(transaction, RESTORE_TRANSACTION_FILE), RESTORE_TRANSACTION_OPTIONS));
  } catch (error) {
    if (error instanceof OperatorError) throw error;
    throw new OperatorError('SNAPSHOT_RESTORE_TRANSACTION_CORRUPT', 'Snapshot restore transaction journal could not be parsed.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new OperatorError('SNAPSHOT_RESTORE_TRANSACTION_CORRUPT', 'Snapshot restore transaction journal must be an object.');
  }
  const raw = parsed as Record<string, unknown>;
  const body = validateRestoreTransactionBody({
    version: raw.version as 1,
    stateDir: raw.stateDir as string,
    epoch: raw.epoch as string,
    manifestDigest: raw.manifestDigest as string,
    phase: raw.phase as RestoreTransactionBody['phase'],
    stores: raw.stores as RestoreTransactionStore[],
    createdAt: raw.createdAt as string,
    updatedAt: raw.updatedAt as string
  });
  const recordDigest = String(raw.recordDigest ?? '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(recordDigest) || recordDigest !== digestJson(body)) {
    throw new OperatorError('SNAPSHOT_RESTORE_TRANSACTION_CORRUPT', 'Snapshot restore transaction digest does not match its contents.');
  }
  if (!sameStatePath(body.stateDir, expectedStateDir)) {
    throw new OperatorError('SNAPSHOT_RESTORE_TRANSACTION_CORRUPT', 'Snapshot restore transaction is bound to a different state directory.');
  }
  return { ...body, recordDigest };
}

function validateRestoreTransactionBody(input: RestoreTransactionBody): RestoreTransactionBody {
  if (!input || input.version !== 1 || !sameStatePath(input.stateDir, path.resolve(input.stateDir))
    || !/^[0-9a-f]{64}$/.test(String(input.manifestDigest ?? ''))
    || (input.phase !== 'PREPARED' && input.phase !== 'COMMITTED')
    || !Array.isArray(input.stores) || input.stores.length > 5000) {
    throw new OperatorError('SNAPSHOT_RESTORE_TRANSACTION_CORRUPT', 'Snapshot restore transaction shape is invalid.');
  }
  const epoch = validEpoch(String(input.epoch ?? ''));
  const createdAt = exactIso(input.createdAt, 'createdAt');
  const updatedAt = exactIso(input.updatedAt, 'updatedAt');
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw new OperatorError('SNAPSHOT_RESTORE_TRANSACTION_CORRUPT', 'Snapshot restore transaction timestamps are invalid.');
  }
  const seen = new Set<string>();
  const stores = input.stores.map((store) => {
    if (!store || typeof store !== 'object' || typeof store.targetLocation !== 'string'
      || typeof store.hadOriginal !== 'boolean' || typeof store.snapshotPresent !== 'boolean') {
      throw new OperatorError('SNAPSHOT_RESTORE_TRANSACTION_CORRUPT', 'Snapshot restore transaction store entry is invalid.');
    }
    const targetLocation = store.targetLocation;
    if (!targetLocation || targetLocation.length > 1024 || targetLocation.includes('\\') || path.isAbsolute(targetLocation)
      || targetLocation.split('/').includes('..') || seen.has(targetLocation)) {
      throw new OperatorError('SNAPSHOT_RESTORE_TRANSACTION_CORRUPT', 'Snapshot restore transaction target location is invalid.');
    }
    seen.add(targetLocation);
    return { targetLocation, hadOriginal: store.hadOriginal, snapshotPresent: store.snapshotPresent };
  });
  return {
    version: 1,
    stateDir: path.resolve(input.stateDir),
    epoch,
    manifestDigest: String(input.manifestDigest).toLowerCase(),
    phase: input.phase,
    stores,
    createdAt,
    updatedAt
  };
}

async function recoverRestoreTransaction(
  transaction: string,
  stateDirInput: string,
  suppliedRecord?: RestoreTransactionRecord
): Promise<void> {
  const stateDir = path.resolve(stateDirInput);
  const record = suppliedRecord ?? await readRestoreTransaction(transaction, stateDir);
  if (record.phase === 'COMMITTED') {
    await fs.rm(transaction, { recursive: true, force: true });
    return;
  }

  const rollback = path.join(transaction, 'rollback');
  const staged = path.join(transaction, 'staged');
  const failures: string[] = [];
  for (const store of [...record.stores].reverse()) {
    const target = safeJoin(stateDir, store.targetLocation);
    const rollbackTarget = safeJoin(rollback, store.targetLocation);
    const stagedTarget = safeJoin(staged, store.targetLocation);
    try {
      await assertNoSymlink(target);
      if (store.hadOriginal) {
        if (await exists(rollbackTarget)) {
          await assertNoSymlink(rollbackTarget);
          await fs.rm(target, { recursive: true, force: true });
          await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
          await fs.rename(rollbackTarget, target);
        } else {
          const targetExists = await exists(target);
          const stagedExists = await exists(stagedTarget);
          if (!targetExists || (store.snapshotPresent && !stagedExists)) {
            throw new Error('required rollback source is missing after live-state replacement began');
          }
        }
      } else {
        if (await exists(rollbackTarget)) throw new Error('unexpected rollback source exists for a previously absent store');
        await fs.rm(target, { recursive: true, force: true });
      }
    } catch (error) {
      failures.push(`${store.targetLocation}:${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length > 0) {
    throw new OperatorError('SNAPSHOT_RESTORE_RECOVERY_INCOMPLETE', 'Snapshot restore transaction could not be rolled back completely.', {
      retryable: false,
      details: { transaction, failures }
    });
  }
  await fs.rm(transaction, { recursive: true, force: true });
}

function restoreTransactionPrefix(stateDir: string): string {
  const resolved = path.resolve(stateDir);
  const identity = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  const digest = crypto.createHash('sha256').update(identity, 'utf8').digest('hex').slice(0, 16);
  return `${RESTORE_TRANSACTION_PREFIX}${digest}-`;
}

function sameStatePath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function exactIso(input: unknown, label: string): string {
  const value = String(input ?? '');
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new OperatorError('SNAPSHOT_RESTORE_TRANSACTION_CORRUPT', `Snapshot restore transaction ${label} is invalid.`);
  }
  return value;
}

function snapshotCatalog() {
  return PERSISTENT_DATA_CATALOG.filter((item) => item.backup === 'include' && item.restore !== 'never');
}
function catalogDigest(): string {
  return digestJson(snapshotCatalog().map(({ id, location, restore }) => ({ id, location, restore, monotonicRestore: isMonotonicRestoreStore(id) })));
}
export function currentSnapshotCatalogDigest(): string { return catalogDigest(); }
function storeRevision(id: string, files: SnapshotFile[]): string { return digestJson({ id, files: files.slice().sort((a, b) => a.path.localeCompare(b.path)) }); }
function authorityDigestFromStores(stores: SnapshotStore[]): string {
  return digestJson(stores.filter((store) => isMonotonicRestoreStore(store.id)).map((store) => ({
    id: store.id, present: store.present, revision: store.revision
  })).sort((a, b) => a.id.localeCompare(b.id)));
}
async function authorityDigestForState(stateDir: string): Promise<string> {
  const stores: SnapshotStore[] = [];
  for (const catalog of snapshotCatalog().filter((item) => isMonotonicRestoreStore(item.id))) {
    const source = safeJoin(stateDir, catalog.location);
    const files = await enumerate(source, catalog.location);
    const manifestFiles: SnapshotFile[] = [];
    for (const file of files) manifestFiles.push({ path: file.relative, bytes: file.bytes, sha256: await sha256File(file.absolute) });
    stores.push({ id: catalog.id, location: catalog.location, present: await exists(source), revision: storeRevision(catalog.id, manifestFiles), files: manifestFiles });
  }
  return authorityDigestFromStores(stores);
}
function digestJson(value: unknown): string { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function signaturePayload(manifestDigest: string, signerKeyId: string): Uint8Array {
  return Buffer.from(JSON.stringify({ purpose: 'mecord-state-snapshot-v2', manifestDigest, signerKeyId }), 'utf8');
}
function normalizeAuthenticator(input: SnapshotAuthenticator): SnapshotAuthenticator {
  if (!input || typeof input !== 'object' || !/^[A-Za-z0-9._:-]{8,256}$/.test(String(input.keyId ?? '')) || typeof input.sign !== 'function' || typeof input.verify !== 'function') {
    throw new OperatorError('SNAPSHOT_AUTHENTICATOR_INVALID', 'Snapshot authenticator is missing or invalid.');
  }
  return input;
}
function validSignature(input: string): string {
  const value = String(input ?? '');
  if (!/^[A-Za-z0-9_-]{40,512}$/.test(value)) throw new OperatorError('SNAPSHOT_SIGNATURE_INVALID', 'Snapshot signature is invalid.');
  return value;
}

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
  if (!manifest || manifest.version !== 2 || validEpoch(manifest.epoch) !== manifest.epoch || !Number.isFinite(Date.parse(manifest.createdAt)) || !Array.isArray(manifest.stores)) throw new OperatorError('SNAPSHOT_MANIFEST_INVALID', 'Snapshot manifest shape is invalid.');
  if (!/^[0-9a-f]{64}$/.test(manifest.catalogDigest) || !/^[0-9a-f]{64}$/.test(manifest.authorityDigest) || !/^[0-9a-f]{64}$/.test(manifest.manifestDigest)) throw new OperatorError('SNAPSHOT_MANIFEST_INVALID', 'Snapshot manifest digests are invalid.');
  if (!/^[A-Za-z0-9._:-]{8,256}$/.test(manifest.signerKeyId) || !/^[A-Za-z0-9_-]{40,512}$/.test(manifest.signature)) throw new OperatorError('SNAPSHOT_MANIFEST_INVALID', 'Snapshot authentication metadata is invalid.');
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
function boundedMigrationId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value)) throw new OperatorError('SNAPSHOT_MIGRATION_INVALID', 'Snapshot migration id is invalid.');
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
