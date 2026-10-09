import crypto from 'node:crypto';
import path from 'node:path';
import { canonicalJson } from './action-identity.ts';
import { readDurableStateText, writeDurableStateText } from './durable-state.ts';
import { OperatorError } from './errors.ts';
import { withDurableStateLock } from './durable-state-lock.ts';

export interface ControlPlaneRecord {
  schemaVersion: 1;
  namespace: string;
  key: string;
  generation: number;
  valueDigest: string;
  value: Record<string, unknown>;
  updatedAt: string;
  expiresAt?: string;
}

export interface ControlPlaneSnapshot {
  schemaVersion: 1;
  createdAt: string;
  records: ControlPlaneRecord[];
  // Generation history belongs to the snapshot digest, even for deleted or expired keys.
  // Legacy snapshots without this field are not safe to restore after key deletion.
  tombstones?: ControlPlaneGenerationFence[];
  digest: string;
}

export interface ControlPlaneMutation {
  namespace: string;
  key: string;
  expectedGeneration: number | null;
  value: Record<string, unknown> | null;
  expiresAt?: string;
}

export interface ControlPlaneStore {
  get(namespace: string, key: string): Promise<ControlPlaneRecord | null>;
  list(namespace: string): Promise<ControlPlaneRecord[]>;
  transact(mutations: ControlPlaneMutation[], now?: string): Promise<ControlPlaneRecord[]>;
  snapshot(now?: string): Promise<ControlPlaneSnapshot>;
  restore(snapshot: ControlPlaneSnapshot): Promise<void>;
}

export interface ControlPlaneMigration {
  id: string;
  mutations: ControlPlaneMutation[];
}

const MIGRATION_NAMESPACE = '__mecord_migrations';

export interface ControlPlaneGenerationFence { namespace: string; key: string; generation: number; }
interface EmbeddedState { version: 1 | 2; records: ControlPlaneRecord[]; tombstones?: ControlPlaneGenerationFence[]; }

const OPTIONS = {
  maxBytes: 256 * 1024 * 1024,
  errorCode: 'CONTROL_PLANE_STORE_CORRUPT',
  invalidMessage: 'Control-plane store state is invalid.'
} as const;
const ID = /^[A-Za-z0-9._:@/+=-]{1,256}$/;

export class EmbeddedControlPlaneStore implements ControlPlaneStore {
  #file: string;
  #serial: Promise<void> = Promise.resolve();

  constructor(stateDir: string) {
    this.#file = path.join(path.resolve(stateDir), 'control-plane-store.json');
  }

  /**
   * Explicitly activate the fencing-aware embedded schema under the cross-
   * process file lock. Pre-upgrade binaries that understand only schema v1
   * then fail closed rather than silently removing tombstones on write.
   * Activation does not reconstruct pre-upgrade physical deletion history.
   */
  async activateGenerationFenceSchema(): Promise<void> {
    const run = this.#serial.then(() => withDurableStateLock(this.#file, async () => {
      const state = await this.#read();
      await this.#write(state);
    }));
    this.#serial = run.then(() => undefined, () => undefined);
    await run;
  }

  async get(namespace: string, key: string): Promise<ControlPlaneRecord | null> {
    await this.#serial;
    const state = await this.#read();
    const record = state.records.find((item) => item.namespace === id(namespace, 'namespace') && item.key === id(key, 'key'));
    return record ? structuredClone(record) : null;
  }

  async list(namespace: string): Promise<ControlPlaneRecord[]> {
    await this.#serial;
    const ns = id(namespace, 'namespace');
    return (await this.#read()).records
      .filter((item) => item.namespace === ns)
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((item) => structuredClone(item));
  }

  async transact(mutations: ControlPlaneMutation[], nowInput = new Date().toISOString()): Promise<ControlPlaneRecord[]> {
    if (!Array.isArray(mutations) || mutations.length < 1 || mutations.length > 10001) throw invalid('Transaction mutations are invalid.');
    const now = iso(nowInput, 'now');
    let output: ControlPlaneRecord[] = [];
    const run = this.#serial.then(() => withDurableStateLock(this.#file, async () => {
      const state = await this.#read();
      const index = new Map(state.records.map((item, i) => [recordKey(item.namespace, item.key), i]));
      const tombstones = new Map((state.tombstones ?? []).map((item) => [recordKey(item.namespace, item.key), item]));
      const seen = new Set<string>();
      const normalized = mutations.map((item) => normalizeMutation(item));
      for (const mutation of normalized) {
        const rk = recordKey(mutation.namespace, mutation.key);
        if (seen.has(rk)) throw invalid('A transaction cannot mutate the same record twice.');
        seen.add(rk);
        const position = index.get(rk);
        const current = position === undefined ? undefined : state.records[position];
        const effective = current && !expired(current, Date.parse(now)) ? current : undefined;
        if (mutation.expectedGeneration === null) {
          if (effective) throw new OperatorError('CONTROL_PLANE_CAS_MISMATCH', 'Record already exists.');
        } else if (!effective || effective.generation !== mutation.expectedGeneration) {
          throw new OperatorError('CONTROL_PLANE_CAS_MISMATCH', 'Record generation changed.', { retryable: true });
        }
      }

      const results: ControlPlaneRecord[] = [];
      for (const mutation of normalized) {
        const rk = recordKey(mutation.namespace, mutation.key);
        const position = index.get(rk);
        const current = position === undefined ? undefined : state.records[position];
        if (mutation.value === null) {
          if (position !== undefined) {
            // Preserve the last generation after physical removal, preventing ABA on key reuse.
            tombstones.set(rk, { namespace: current!.namespace, key: current!.key, generation: current!.generation });
            state.records.splice(position, 1);
            // Rebuild after splice to retain correct positions for following distinct keys.
            index.clear();
            state.records.forEach((item, i) => index.set(recordKey(item.namespace, item.key), i));
          }
          continue;
        }
        const priorGeneration = Math.max(current?.generation ?? 0, tombstones.get(rk)?.generation ?? 0);
        if (priorGeneration >= Number.MAX_SAFE_INTEGER) throw invalid('Control-plane record generation exhausted.');
        const generation = priorGeneration + 1;
        tombstones.delete(rk);
        const record = makeRecord(mutation.namespace, mutation.key, generation, mutation.value, now, mutation.expiresAt);
        const updatedPosition = index.get(rk);
        if (updatedPosition === undefined) {
          state.records.push(record);
          index.set(rk, state.records.length - 1);
        } else state.records[updatedPosition] = record;
        results.push(record);
      }
      state.records.sort((a, b) => recordKey(a.namespace, a.key).localeCompare(recordKey(b.namespace, b.key)));
      state.tombstones = [...tombstones.values()].sort((a, b) => recordKey(a.namespace, a.key).localeCompare(recordKey(b.namespace, b.key)));
      await this.#write(state);
      output = results.map((item) => structuredClone(item));
    }));
    this.#serial = run.then(() => undefined, () => undefined);
    await run;
    return output;
  }

  async snapshot(nowInput = new Date().toISOString()): Promise<ControlPlaneSnapshot> {
    await this.#serial;
    const now = iso(nowInput, 'now');
    const state = await this.#read();
    const records = state.records.filter((item) => !expired(item, Date.parse(now))).map((item) => structuredClone(item));
    // Expiry hides a key from reads, not from generation fencing. Preserve the
    // highest generation even if a purge has not yet converted it to a tombstone.
    const tombstones = [...(state.tombstones ?? []), ...state.records.filter((item) => expired(item, Date.parse(now)))
      .map(({ namespace, key, generation }) => ({ namespace, key, generation }))]
      .sort((a, b) => recordKey(a.namespace, a.key).localeCompare(recordKey(b.namespace, b.key)));
    const base = { schemaVersion: 1 as const, createdAt: now, records, tombstones };
    return { ...base, digest: digest(base) };
  }

  async restore(snapshotInput: ControlPlaneSnapshot): Promise<void> {
    const snapshot = normalizeSnapshot(snapshotInput);
    const run = this.#serial.then(() => withDurableStateLock(this.#file, async () => {
      const current = await this.#read();
      if (current.records.length > 0 || (current.tombstones?.length ?? 0) > 0) throw new OperatorError('CONTROL_PLANE_RESTORE_CONFLICT', 'Restore refuses to overwrite existing control-plane records or generation fences.');
      await this.#write({ version: 2, records: snapshot.records.map((item) => structuredClone(item)),
        tombstones: snapshot.tombstones!.map((item) => structuredClone(item)) });
    }));
    this.#serial = run.then(() => undefined, () => undefined);
    await run;
  }

  async #read(): Promise<EmbeddedState> {
    try {
      const parsed = JSON.parse(await readDurableStateText(this.#file, OPTIONS)) as EmbeddedState;
      return normalizeState(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 2, records: [], tombstones: [] };
      if (error instanceof OperatorError) throw error;
      throw new OperatorError('CONTROL_PLANE_STORE_CORRUPT', 'Control-plane store could not be read.');
    }
  }

  async #write(state: EmbeddedState): Promise<void> {
    const normalized = normalizeState(state);
    await writeDurableStateText(this.#file, JSON.stringify(normalized, null, 2), OPTIONS);
  }
}

export interface PostgresQueryResult<Row = Record<string, unknown>> { rows: Row[]; rowCount?: number | null; }
export interface PostgresQueryClient {
  query<Row = Record<string, unknown>>(text: string, values?: unknown[]): Promise<PostgresQueryResult<Row>>;
  release?(error?: Error): void;
}
export interface PostgresQueryHost extends PostgresQueryClient {
  connect?(): Promise<PostgresQueryClient>;
}

interface DirectConnectionState { tail: Promise<void>; unsafe: boolean; }
const directConnectionStates = new WeakMap<PostgresQueryHost, DirectConnectionState>();
function directConnectionState(db: PostgresQueryHost): DirectConnectionState {
  let state = directConnectionStates.get(db);
  if (!state) {
    state = { tail: Promise.resolve(), unsafe: false };
    directConnectionStates.set(db, state);
  }
  return state;
}

export class PostgresControlPlaneStore implements ControlPlaneStore {
  #db: PostgresQueryHost;
  #directState?: DirectConnectionState;

  constructor(db: PostgresQueryHost) {
    this.#db = db;
    if (typeof db.connect !== 'function') this.#directState = directConnectionState(db);
  }

  // A direct pg.Client is one transaction/session, even when multiple store
  // wrappers share it. Queue *all* operations on it to avoid read-during-
  // transaction and nested BEGIN/COMMIT across unrelated requests.
  async #onConnection<T>(work: () => Promise<T>): Promise<T> {
    const state = this.#directState;
    if (!state) return await work();
    const run = state.tail.then(async () => {
      if (state.unsafe) throw new OperatorError('CONTROL_PLANE_CONNECTION_UNSAFE', 'Control-plane connection is unsafe after a failed rollback.');
      return await work();
    });
    state.tail = run.then(() => undefined, () => undefined);
    return await run;
  }

  async initialize(): Promise<void> {
    await this.#onConnection(async () => this.#db.query(`
CREATE TABLE IF NOT EXISTS mecord_control_plane (
  namespace TEXT NOT NULL,
  record_key TEXT NOT NULL,
  generation BIGINT NOT NULL,
  value_digest CHAR(64) NOT NULL,
  value_json JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NULL,
  is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY(namespace, record_key)
);
ALTER TABLE mecord_control_plane ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS mecord_control_plane_expiry_idx ON mecord_control_plane(expires_at);
-- This table must remain safe while a pre-migration worker is still connected.
-- Legacy DELETE would discard the key's lifetime generation history (ABA).
-- Legacy UPDATE/UPSERT may also try to reuse or roll back a generation.
-- Reject those writes inside PostgreSQL itself, not just in the new SDK.
CREATE OR REPLACE FUNCTION mecord_control_plane_generation_guard()
RETURNS trigger LANGUAGE plpgsql AS $mecord_guard$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE='23514',
      MESSAGE='CONTROL_PLANE_LEGACY_DELETE_FENCED: physical deletion is prohibited';
  END IF;
  IF NEW.generation < OLD.generation OR (
      NEW.generation = OLD.generation AND NOT (
        OLD.is_deleted = FALSE AND NEW.is_deleted = TRUE AND
        NEW.value_json = '{}'::jsonb AND NEW.expires_at IS NULL
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE='23514',
      MESSAGE='CONTROL_PLANE_LEGACY_GENERATION_FENCED: stale or nonadvancing mutation';
  END IF;
  RETURN NEW;
END;
$mecord_guard$;
DO $mecord_trigger$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'mecord_control_plane'::regclass
      AND tgname = 'mecord_control_plane_generation_guard_trigger'
      AND NOT tgisinternal
  ) THEN
    BEGIN
      CREATE TRIGGER mecord_control_plane_generation_guard_trigger
        BEFORE UPDATE OR DELETE ON mecord_control_plane
        FOR EACH ROW EXECUTE FUNCTION mecord_control_plane_generation_guard();
    EXCEPTION WHEN duplicate_object THEN
      -- Concurrent initialize() on another host installed the same guard.
      NULL;
    END;
  END IF;
END;
$mecord_trigger$;
-- Row-level DELETE guards do not run for TRUNCATE; fence that independent
-- DDL path as well. Full-cluster restore must use the verified explicit
-- snapshot protocol, never wipe hidden generation history as a shortcut.
CREATE OR REPLACE FUNCTION mecord_control_plane_truncate_guard()
RETURNS trigger LANGUAGE plpgsql AS $mecord_truncate$
BEGIN
  RAISE EXCEPTION USING ERRCODE='23514',
    MESSAGE='CONTROL_PLANE_LEGACY_TRUNCATE_FENCED: authority history cannot be truncated';
END;
$mecord_truncate$;
DO $mecord_truncate_trigger$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'mecord_control_plane'::regclass
      AND tgname = 'mecord_control_plane_truncate_guard_trigger'
      AND NOT tgisinternal
  ) THEN
    BEGIN
      CREATE TRIGGER mecord_control_plane_truncate_guard_trigger
        BEFORE TRUNCATE ON mecord_control_plane
        FOR EACH STATEMENT EXECUTE FUNCTION mecord_control_plane_truncate_guard();
    EXCEPTION WHEN duplicate_object THEN
      NULL;
    END;
  END IF;
END;
$mecord_truncate_trigger$;
`));
  }

  async get(namespace: string, key: string): Promise<ControlPlaneRecord | null> {
    const ns = id(namespace, 'namespace');
    const recordKeyValue = id(key, 'key');
    return await this.#onConnection(async () => {
      const result = await this.#db.query<any>(
        'SELECT namespace, record_key, generation, value_digest, value_json, updated_at, expires_at, is_deleted FROM mecord_control_plane WHERE namespace=$1 AND record_key=$2',
        [ns, recordKeyValue]
      );
      return result.rows[0] && result.rows[0].is_deleted !== true ? rowToRecord(result.rows[0]) : null;
    });
  }

  async list(namespace: string): Promise<ControlPlaneRecord[]> {
    const ns = id(namespace, 'namespace');
    return await this.#onConnection(async () => {
      const result = await this.#db.query<any>(
        'SELECT namespace, record_key, generation, value_digest, value_json, updated_at, expires_at, is_deleted FROM mecord_control_plane WHERE namespace=$1 AND is_deleted=FALSE ORDER BY record_key',
        [ns]
      );
      return result.rows.map(rowToRecord);
    });
  }

  async transact(mutations: ControlPlaneMutation[], nowInput = new Date().toISOString()): Promise<ControlPlaneRecord[]> {
    if (!Array.isArray(mutations) || mutations.length < 1 || mutations.length > 10001) throw invalid('Transaction mutations are invalid.');
    const now = iso(nowInput,'now');
    const normalized = mutations.map(normalizeMutation);
    const seen = new Set<string>();
    for (const item of normalized) {
      const rk = recordKey(item.namespace,item.key);
      if (seen.has(rk)) throw invalid('A transaction cannot mutate the same record twice.');
      seen.add(rk);
    }
    return await this.#withTransaction(async (db) => {
      const out: ControlPlaneRecord[] = [];
      // Row locks cannot fence a key that does not exist yet. Acquire a
      // deterministic transaction-scoped advisory lock for every logical key
      // first so create-if-absent CAS is serialized across all writers.
      for (const item of [...normalized].sort((a,b)=>recordKey(a.namespace,a.key).localeCompare(recordKey(b.namespace,b.key)))) {
        await db.query('SELECT pg_advisory_xact_lock($1::bigint)', [advisoryLockKey(item.namespace,item.key)]);
      }
      for (const item of normalized) {
        const locked = await db.query<any>(
          'SELECT generation, expires_at, is_deleted FROM mecord_control_plane WHERE namespace=$1 AND record_key=$2 FOR UPDATE',
          [item.namespace,item.key]
        );
        const row = locked.rows[0];
        const priorGeneration = row ? storedGeneration(row.generation) : 0;
        const live = Boolean(row && row.is_deleted !== true && (!row.expires_at || Date.parse(String(row.expires_at)) > Date.parse(now)));
        if (item.expectedGeneration === null ? live : (!live || priorGeneration !== item.expectedGeneration)) {
          throw new OperatorError('CONTROL_PLANE_CAS_MISMATCH','Record generation changed.',{retryable:true});
        }
        if (item.value === null) {
          // A physical DELETE would recycle generation 1 on recreation (ABA).
          // Retain an invisible durable tombstone under the same advisory key lock.
          if (row && row.is_deleted !== true) {
            await db.query(
              'UPDATE mecord_control_plane SET is_deleted=TRUE, value_digest=$3, value_json=$4::jsonb, updated_at=$5, expires_at=NULL WHERE namespace=$1 AND record_key=$2',
              [item.namespace, item.key, digest({}), JSON.stringify({}), now]
            );
          }
          continue;
        }
        // Expiry makes a row logically absent for CAS, but it does not erase
        // its fencing history. Re-creation must advance, never recycle, the
        // prior generation.
        if (priorGeneration >= Number.MAX_SAFE_INTEGER) throw invalid('Control-plane record generation exhausted.');
        const record = makeRecord(item.namespace,item.key,priorGeneration+1,item.value,now,item.expiresAt);
        await db.query(
          `INSERT INTO mecord_control_plane(namespace,record_key,generation,value_digest,value_json,updated_at,expires_at)
           VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)
           ON CONFLICT(namespace,record_key) DO UPDATE SET generation=EXCLUDED.generation,value_digest=EXCLUDED.value_digest,value_json=EXCLUDED.value_json,updated_at=EXCLUDED.updated_at,expires_at=EXCLUDED.expires_at,is_deleted=FALSE`,
          [record.namespace,record.key,record.generation,record.valueDigest,JSON.stringify(record.value),record.updatedAt,record.expiresAt ?? null]
        );
        out.push(record);
      }
      return out;
    });
  }

  async snapshot(nowInput = new Date().toISOString()): Promise<ControlPlaneSnapshot> {
    const now = iso(nowInput,'now');
    return await this.#onConnection(async () => {
      // One database statement observes a consistent set of live rows and
      // deletion/expiry generation fences, including keys hidden from get/list.
      const result = await this.#db.query<any>(
        'SELECT namespace, record_key, generation, value_digest, value_json, updated_at, expires_at, is_deleted FROM mecord_control_plane ORDER BY namespace,record_key'
      );
      const records: ControlPlaneRecord[] = [];
      const tombstones: ControlPlaneGenerationFence[] = [];
      for (const row of result.rows) {
        if (row.is_deleted === true || (row.expires_at && Date.parse(String(row.expires_at)) <= Date.parse(now))) {
          tombstones.push({ namespace: id(row.namespace, 'namespace'), key: id(row.record_key, 'key'), generation: storedGeneration(row.generation) });
        } else records.push(rowToRecord(row));
      }
      const base = { schemaVersion: 1 as const, createdAt: now, records, tombstones };
      return { ...base, digest: digest(base) };
    });
  }

  async restore(snapshotInput: ControlPlaneSnapshot): Promise<void> {
    const snapshot = normalizeSnapshot(snapshotInput);
    await this.#withTransaction(async (db) => {
      // Restore is a whole-store operation. Prevent concurrent writers from
      // observing the empty precondition and interleaving live state while the
      // snapshot is being installed.
      await db.query('LOCK TABLE mecord_control_plane IN ACCESS EXCLUSIVE MODE');
      const existing = await db.query<any>('SELECT COUNT(*)::bigint AS count FROM mecord_control_plane');
      if (Number(existing.rows[0]?.count ?? 0) > 0) throw new OperatorError('CONTROL_PLANE_RESTORE_CONFLICT', 'Restore refuses to overwrite live control-plane state.');
      for (const record of snapshot.records) {
        await db.query(
          'INSERT INTO mecord_control_plane(namespace,record_key,generation,value_digest,value_json,updated_at,expires_at) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)',
          [record.namespace,record.key,record.generation,record.valueDigest,JSON.stringify(record.value),record.updatedAt,record.expiresAt ?? null]
        );
      }
      for (const fence of snapshot.tombstones!) {
        await db.query(
          'INSERT INTO mecord_control_plane(namespace,record_key,generation,value_digest,value_json,updated_at,expires_at,is_deleted) VALUES($1,$2,$3,$4,$5::jsonb,$6,NULL,TRUE)',
          [fence.namespace, fence.key, fence.generation, digest({}), JSON.stringify({}), snapshot.createdAt]
        );
      }
    });
  }

  async #withTransaction<T>(work: (db: PostgresQueryClient) => Promise<T>): Promise<T> {
    return await this.#onConnection(async () => {
    const pooled = typeof this.#db.connect === 'function';
    const db = pooled ? await this.#db.connect!() : this.#db;
    let began = false;
    let releaseError: Error | undefined;
    try {
      await db.query('BEGIN');
      began = true;
      const result = await work(db);
      await db.query('COMMIT');
      began = false;
      return result;
    } catch (error) {
      if (began) {
        try { await db.query('ROLLBACK'); }
        catch (rollbackError) {
          releaseError = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
          if (!pooled) this.#directState!.unsafe = true;
        }
      }
      throw error;
    } finally {
      if (pooled) db.release?.(releaseError);
    }
    });
  }
}

export async function applyControlPlaneMigration(
  store: ControlPlaneStore,
  migrationInput: ControlPlaneMigration,
  now = new Date().toISOString()
): Promise<boolean> {
  if (!migrationInput || typeof migrationInput !== 'object') throw invalid('Migration is invalid.');
  const migrationId = id(migrationInput.id, 'migration.id');
  if (!Array.isArray(migrationInput.mutations) || migrationInput.mutations.length > 10000) throw invalid('Migration mutations are invalid.');
  const markerKey = 'migration:' + migrationId;
  if (await store.get(MIGRATION_NAMESPACE, markerKey)) return false;
  try {
    await store.transact([
      ...migrationInput.mutations,
      {
        namespace: MIGRATION_NAMESPACE,
        key: markerKey,
        expectedGeneration: null,
        value: { migrationId, applied: true }
      }
    ], iso(now, 'now'));
    return true;
  } catch (error) {
    // A concurrent migrator may have committed after our optimistic pre-read.
    // Treat that as the same idempotent outcome only when the durable marker
    // is now present; unrelated CAS conflicts must still surface.
    if (error instanceof OperatorError && error.code === 'CONTROL_PLANE_CAS_MISMATCH'
        && await store.get(MIGRATION_NAMESPACE, markerKey)) return false;
    throw error;
  }
}

export async function purgeExpiredControlPlaneRecords(
  store: ControlPlaneStore,
  namespaceInput: string,
  nowInput = new Date().toISOString()
): Promise<number> {
  const namespace = id(namespaceInput, 'namespace');
  const now = iso(nowInput, 'now');
  const nowMs = Date.parse(now);
  const expiredRecords = (await store.list(namespace)).filter((record) => record.expiresAt && Date.parse(record.expiresAt) <= nowMs);
  let removed = 0;
  for (const record of expiredRecords) {
    try {
      // Expired records are logically absent. expectedGeneration:null deletes only while
      // they remain expired; a concurrent renewal becomes live and makes this fail closed.
      await store.transact([{ namespace, key: record.key, expectedGeneration: null, value: null }], now);
      removed += 1;
    } catch (error) {
      if (error instanceof OperatorError && error.code === 'CONTROL_PLANE_CAS_MISMATCH') continue;
      throw error;
    }
  }
  return removed;
}

function advisoryLockKey(namespace:string,key:string):string {
  const bytes=crypto.createHash('sha256').update(recordKey(namespace,key),'utf8').digest();
  return bytes.readBigInt64BE(0).toString();
}
function storedGeneration(input: unknown): number {
  const value = Number(input);
  if (!Number.isSafeInteger(value) || value < 1) throw corrupt('Postgres control-plane generation is invalid.');
  return value;
}
function rowToRecord(row: any): ControlPlaneRecord {
  return normalizeRecord({
    schemaVersion: 1,
    namespace: row.namespace,
    key: row.record_key,
    generation: Number(row.generation),
    valueDigest: row.value_digest,
    value: typeof row.value_json === 'string' ? JSON.parse(row.value_json) : row.value_json,
    updatedAt: new Date(row.updated_at).toISOString(),
    ...(row.expires_at ? { expiresAt: new Date(row.expires_at).toISOString() } : {})
  });
}
function normalizeState(input: EmbeddedState): EmbeddedState {
  if (!input || (input.version !== 1 && input.version !== 2) || !Array.isArray(input.records) || input.records.length > 1_000_000) throw corrupt('State shape is invalid.');
  if (input.version === 2 && !Array.isArray(input.tombstones)) throw corrupt('Fencing-aware embedded control-plane state is missing tombstones.');
  const records = input.records.map(normalizeRecord);
  const keys = new Set<string>();
  for (const item of records) {
    const rk=recordKey(item.namespace,item.key);
    if(keys.has(rk)) throw corrupt('Duplicate control-plane record.');
    keys.add(rk);
  }
  // Old version-1 files lack tombstones. Preserve new deletion fences durably
  // without surfacing them to get/list or snapshot callers.
  const rawTombstones = input.tombstones ?? [];
  if (!Array.isArray(rawTombstones) || rawTombstones.length > 1_000_000) throw corrupt('Control-plane generation fence collection is invalid.');
  const tombstones = rawTombstones.map((item) => ({
    namespace: id(item.namespace, 'tombstone.namespace'),
    key: id(item.key, 'tombstone.key'),
    generation: integer(item.generation, 1, Number.MAX_SAFE_INTEGER, 'tombstone.generation')
  }));
  for (const item of tombstones) {
    const rk = recordKey(item.namespace, item.key);
    if (keys.has(rk)) throw corrupt('Generation fence duplicates a live record or another fence.');
    keys.add(rk);
  }
  return { version: 2, records, tombstones };
}
function normalizeRecord(input: ControlPlaneRecord): ControlPlaneRecord {
  if (!input || input.schemaVersion !== 1) throw corrupt('Record schema is invalid.');
  const value = objectValue(input.value);
  const record: ControlPlaneRecord = {
    schemaVersion: 1,
    namespace: id(input.namespace,'namespace'),
    key: id(input.key,'key'),
    generation: integer(input.generation,1,Number.MAX_SAFE_INTEGER,'generation'),
    valueDigest: sha(input.valueDigest,'valueDigest'),
    value,
    updatedAt: iso(input.updatedAt,'updatedAt'),
    ...(input.expiresAt !== undefined ? { expiresAt: iso(input.expiresAt,'expiresAt') } : {})
  };
  if (record.valueDigest !== digest(value)) throw corrupt('Record value digest mismatch.');
  return record;
}
function normalizeMutation(input: ControlPlaneMutation): ControlPlaneMutation {
  if (!input || typeof input !== 'object') throw invalid('Mutation is invalid.');
  const expected = input.expectedGeneration === null ? null : integer(input.expectedGeneration,1,Number.MAX_SAFE_INTEGER,'expectedGeneration');
  return {
    namespace:id(input.namespace,'namespace'),key:id(input.key,'key'),expectedGeneration:expected,
    value: input.value === null ? null : objectValue(input.value),
    ...(input.expiresAt !== undefined ? { expiresAt: iso(input.expiresAt,'expiresAt') } : {})
  };
}
function normalizeSnapshot(input: ControlPlaneSnapshot): ControlPlaneSnapshot {
  if(!input||input.schemaVersion!==1||!Array.isArray(input.records)) throw invalid('Snapshot is invalid.');
  if (!Array.isArray(input.tombstones)) throw invalid('Legacy snapshot has no durable generation fences; restore requires an epoch-aware migration.');
  if (input.tombstones.length > 1_000_000 || input.records.length > 1_000_000) throw invalid('Snapshot exceeds control-plane bounds.');
  const records=input.records.map(normalizeRecord).sort((a,b)=>recordKey(a.namespace,a.key).localeCompare(recordKey(b.namespace,b.key)));
  const tombstones=input.tombstones.map((item) => ({
    namespace: id(item.namespace, 'snapshot.tombstone.namespace'),
    key: id(item.key, 'snapshot.tombstone.key'),
    generation: integer(item.generation, 1, Number.MAX_SAFE_INTEGER, 'snapshot.tombstone.generation')
  })).sort((a,b)=>recordKey(a.namespace,a.key).localeCompare(recordKey(b.namespace,b.key)));
  const keys = new Set<string>();
  for (const item of [...records, ...tombstones]) {
    const key = recordKey(item.namespace, item.key);
    if (keys.has(key)) throw invalid('Snapshot contains duplicate identities or overlapping generation fences.');
    keys.add(key);
  }
  const base={schemaVersion:1 as const,createdAt:iso(input.createdAt,'createdAt'),records,tombstones};
  if(sha(input.digest,'snapshot.digest')!==digest(base)) throw invalid('Snapshot digest mismatch.');
  return {...base,digest:input.digest.toLowerCase()};
}
function makeRecord(namespace:string,key:string,generation:number,value:Record<string,unknown>,updatedAt:string,expiresAt?:string):ControlPlaneRecord{
  return {schemaVersion:1,namespace,key,generation,valueDigest:digest(value),value:structuredClone(value),updatedAt,...(expiresAt?{expiresAt}:{})};
}
function objectValue(input:unknown):Record<string,unknown>{
  if(!input||typeof input!=='object'||Array.isArray(input)) throw invalid('Control-plane value must be an object.');
  const encoded=canonicalJson(input);
  if(Buffer.byteLength(encoded,'utf8')>32*1024*1024) throw invalid('Control-plane value exceeds 32 MiB.');
  return structuredClone(input as Record<string,unknown>);
}
function expired(record:ControlPlaneRecord,now:number):boolean{return Boolean(record.expiresAt&&Date.parse(record.expiresAt)<=now);}
function recordKey(namespace:string,key:string):string{return namespace+'\u0000'+key;}
function digest(value:unknown):string{return crypto.createHash('sha256').update(canonicalJson(value),'utf8').digest('hex');}
function id(value:unknown,label:string):string{const s=String(value??'');if(!ID.test(s))throw invalid(label+' is invalid.');return s;}
function iso(value:unknown,label:string):string{const s=String(value??'');if(!s||!Number.isFinite(Date.parse(s))||new Date(s).toISOString()!==s)throw invalid(label+' must be canonical ISO.');return s;}
function integer(value:unknown,min:number,max:number,label:string):number{const n=Number(value);if(!Number.isSafeInteger(n)||n<min||n>max)throw invalid(label+' is invalid.');return n;}
function sha(value:unknown,label:string):string{const s=String(value??'').toLowerCase();if(!/^[0-9a-f]{64}$/.test(s))throw invalid(label+' must be SHA-256.');return s;}
function invalid(message:string):OperatorError{return new OperatorError('CONTROL_PLANE_STORE_INVALID',message);}
function corrupt(message:string):OperatorError{return new OperatorError('CONTROL_PLANE_STORE_CORRUPT',message);}
