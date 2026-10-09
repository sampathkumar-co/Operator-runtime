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

interface EmbeddedTombstone { namespace: string; key: string; generation: number; }
interface EmbeddedState { version: 1; records: ControlPlaneRecord[]; tombstones?: EmbeddedTombstone[]; }

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
    const records = (await this.#read()).records.filter((item) => !expired(item, Date.parse(now))).map((item) => structuredClone(item));
    const base = { schemaVersion: 1 as const, createdAt: now, records };
    return { ...base, digest: digest(base) };
  }

  async restore(snapshotInput: ControlPlaneSnapshot): Promise<void> {
    const snapshot = normalizeSnapshot(snapshotInput);
    const run = this.#serial.then(() => withDurableStateLock(this.#file, async () => {
      const current = await this.#read();
      if (current.records.length > 0 || (current.tombstones?.length ?? 0) > 0) throw new OperatorError('CONTROL_PLANE_RESTORE_CONFLICT', 'Restore refuses to overwrite existing control-plane records or generation fences.');
      await this.#write({ version: 1, records: snapshot.records.map((item) => structuredClone(item)) });
    }));
    this.#serial = run.then(() => undefined, () => undefined);
    await run;
  }

  async #read(): Promise<EmbeddedState> {
    try {
      const parsed = JSON.parse(await readDurableStateText(this.#file, OPTIONS)) as EmbeddedState;
      return normalizeState(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, records: [], tombstones: [] };
      if (error instanceof OperatorError) throw error;
      throw new OperatorError('CONTROL_PLANE_STORE_CORRUPT', 'Control-plane store could not be read.');
    }
  }

  async #write(state: EmbeddedState): Promise<void> {
    normalizeState(state);
    await writeDurableStateText(this.#file, JSON.stringify(state, null, 2), OPTIONS);
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

export class PostgresControlPlaneStore implements ControlPlaneStore {
  #db: PostgresQueryHost;
  #directTransactionPoisoned = false;

  constructor(db: PostgresQueryHost) { this.#db = db; }

  async initialize(): Promise<void> {
    await this.#db.query(`
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
`);
  }

  async get(namespace: string, key: string): Promise<ControlPlaneRecord | null> {
    const result = await this.#db.query<any>(
      'SELECT namespace, record_key, generation, value_digest, value_json, updated_at, expires_at, is_deleted FROM mecord_control_plane WHERE namespace=$1 AND record_key=$2',
      [id(namespace,'namespace'), id(key,'key')]
    );
    return result.rows[0] && result.rows[0].is_deleted !== true ? rowToRecord(result.rows[0]) : null;
  }

  async list(namespace: string): Promise<ControlPlaneRecord[]> {
    const result = await this.#db.query<any>(
      'SELECT namespace, record_key, generation, value_digest, value_json, updated_at, expires_at, is_deleted FROM mecord_control_plane WHERE namespace=$1 AND is_deleted=FALSE ORDER BY record_key',
      [id(namespace,'namespace')]
    );
    return result.rows.map(rowToRecord);
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
    const result = await this.#db.query<any>(
      'SELECT namespace, record_key, generation, value_digest, value_json, updated_at, expires_at FROM mecord_control_plane WHERE is_deleted=FALSE AND (expires_at IS NULL OR expires_at>$1) ORDER BY namespace,record_key',
      [now]
    );
    const records = result.rows.map(rowToRecord);
    const base = { schemaVersion: 1 as const, createdAt: now, records };
    return { ...base, digest: digest(base) };
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
    });
  }

  async #withTransaction<T>(work: (db: PostgresQueryClient) => Promise<T>): Promise<T> {
    const pooled = typeof this.#db.connect === 'function';
    if (!pooled && this.#directTransactionPoisoned) {
      throw new OperatorError('CONTROL_PLANE_CONNECTION_UNSAFE','Control-plane connection is unsafe after a failed rollback.');
    }
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
          if (!pooled) this.#directTransactionPoisoned = true;
        }
      }
      throw error;
    } finally {
      if (pooled) db.release?.(releaseError);
    }
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
  if (!input || input.version !== 1 || !Array.isArray(input.records) || input.records.length > 1_000_000) throw corrupt('State shape is invalid.');
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
  return { version: 1, records, tombstones };
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
  const records=input.records.map(normalizeRecord).sort((a,b)=>recordKey(a.namespace,a.key).localeCompare(recordKey(b.namespace,b.key)));
  const base={schemaVersion:1 as const,createdAt:iso(input.createdAt,'createdAt'),records};
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
