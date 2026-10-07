import crypto from 'node:crypto';
import path from 'node:path';
import { canonicalJson } from './action-identity.ts';
import { readDurableStateText, writeDurableStateText } from './durable-state.ts';
import { OperatorError } from './errors.ts';

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

interface EmbeddedState { version: 1; records: ControlPlaneRecord[]; }

const OPTIONS = {
  maxBytes: 64 * 1024 * 1024,
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
    if (!Array.isArray(mutations) || mutations.length < 1 || mutations.length > 1000) throw invalid('Transaction mutations are invalid.');
    const now = iso(nowInput, 'now');
    let output: ControlPlaneRecord[] = [];
    const run = this.#serial.then(async () => {
      const state = await this.#read();
      const index = new Map(state.records.map((item, i) => [recordKey(item.namespace, item.key), i]));
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
            state.records.splice(position, 1);
            // Rebuild after splice to retain correct positions for following distinct keys.
            index.clear();
            state.records.forEach((item, i) => index.set(recordKey(item.namespace, item.key), i));
          }
          continue;
        }
        const generation = (current?.generation ?? 0) + 1;
        const record = makeRecord(mutation.namespace, mutation.key, generation, mutation.value, now, mutation.expiresAt);
        const updatedPosition = index.get(rk);
        if (updatedPosition === undefined) {
          state.records.push(record);
          index.set(rk, state.records.length - 1);
        } else state.records[updatedPosition] = record;
        results.push(record);
      }
      state.records.sort((a, b) => recordKey(a.namespace, a.key).localeCompare(recordKey(b.namespace, b.key)));
      await this.#write(state);
      output = results.map((item) => structuredClone(item));
    });
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
    const run = this.#serial.then(async () => {
      await this.#write({ version: 1, records: snapshot.records.map((item) => structuredClone(item)) });
    });
    this.#serial = run.then(() => undefined, () => undefined);
    await run;
  }

  async #read(): Promise<EmbeddedState> {
    try {
      const parsed = JSON.parse(await readDurableStateText(this.#file, OPTIONS)) as EmbeddedState;
      return normalizeState(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, records: [] };
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
}

export class PostgresControlPlaneStore implements ControlPlaneStore {
  #db: PostgresQueryClient;

  constructor(db: PostgresQueryClient) { this.#db = db; }

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
  PRIMARY KEY(namespace, record_key)
);
CREATE INDEX IF NOT EXISTS mecord_control_plane_expiry_idx ON mecord_control_plane(expires_at);
`);
  }

  async get(namespace: string, key: string): Promise<ControlPlaneRecord | null> {
    const result = await this.#db.query<any>(
      'SELECT namespace, record_key, generation, value_digest, value_json, updated_at, expires_at FROM mecord_control_plane WHERE namespace=$1 AND record_key=$2',
      [id(namespace,'namespace'), id(key,'key')]
    );
    return result.rows[0] ? rowToRecord(result.rows[0]) : null;
  }

  async list(namespace: string): Promise<ControlPlaneRecord[]> {
    const result = await this.#db.query<any>(
      'SELECT namespace, record_key, generation, value_digest, value_json, updated_at, expires_at FROM mecord_control_plane WHERE namespace=$1 ORDER BY record_key',
      [id(namespace,'namespace')]
    );
    return result.rows.map(rowToRecord);
  }

  async transact(mutations: ControlPlaneMutation[], nowInput = new Date().toISOString()): Promise<ControlPlaneRecord[]> {
    if (!Array.isArray(mutations) || mutations.length < 1 || mutations.length > 1000) throw invalid('Transaction mutations are invalid.');
    const now = iso(nowInput,'now');
    const normalized = mutations.map(normalizeMutation);
    const seen = new Set<string>();
    for (const item of normalized) {
      const rk = recordKey(item.namespace,item.key);
      if (seen.has(rk)) throw invalid('A transaction cannot mutate the same record twice.');
      seen.add(rk);
    }
    await this.#db.query('BEGIN');
    try {
      const out: ControlPlaneRecord[] = [];
      for (const item of normalized) {
        const locked = await this.#db.query<any>(
          'SELECT generation, expires_at FROM mecord_control_plane WHERE namespace=$1 AND record_key=$2 FOR UPDATE',
          [item.namespace,item.key]
        );
        const row = locked.rows[0];
        const live = row && (!row.expires_at || Date.parse(String(row.expires_at)) > Date.parse(now));
        const generation = live ? Number(row.generation) : 0;
        if (item.expectedGeneration === null ? live : (!live || generation !== item.expectedGeneration)) {
          throw new OperatorError('CONTROL_PLANE_CAS_MISMATCH','Record generation changed.',{retryable:true});
        }
        if (item.value === null) {
          await this.#db.query('DELETE FROM mecord_control_plane WHERE namespace=$1 AND record_key=$2',[item.namespace,item.key]);
          continue;
        }
        const record = makeRecord(item.namespace,item.key,generation+1,item.value,now,item.expiresAt);
        await this.#db.query(
          `INSERT INTO mecord_control_plane(namespace,record_key,generation,value_digest,value_json,updated_at,expires_at)
           VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)
           ON CONFLICT(namespace,record_key) DO UPDATE SET generation=EXCLUDED.generation,value_digest=EXCLUDED.value_digest,value_json=EXCLUDED.value_json,updated_at=EXCLUDED.updated_at,expires_at=EXCLUDED.expires_at`,
          [record.namespace,record.key,record.generation,record.valueDigest,JSON.stringify(record.value),record.updatedAt,record.expiresAt ?? null]
        );
        out.push(record);
      }
      await this.#db.query('COMMIT');
      return out;
    } catch (error) {
      try { await this.#db.query('ROLLBACK'); } catch {}
      throw error;
    }
  }

  async snapshot(nowInput = new Date().toISOString()): Promise<ControlPlaneSnapshot> {
    const now = iso(nowInput,'now');
    const result = await this.#db.query<any>(
      'SELECT namespace, record_key, generation, value_digest, value_json, updated_at, expires_at FROM mecord_control_plane WHERE expires_at IS NULL OR expires_at>$1 ORDER BY namespace,record_key',
      [now]
    );
    const records = result.rows.map(rowToRecord);
    const base = { schemaVersion: 1 as const, createdAt: now, records };
    return { ...base, digest: digest(base) };
  }

  async restore(snapshotInput: ControlPlaneSnapshot): Promise<void> {
    const snapshot = normalizeSnapshot(snapshotInput);
    await this.#db.query('BEGIN');
    try {
      await this.#db.query('DELETE FROM mecord_control_plane');
      for (const record of snapshot.records) {
        await this.#db.query(
          'INSERT INTO mecord_control_plane(namespace,record_key,generation,value_digest,value_json,updated_at,expires_at) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)',
          [record.namespace,record.key,record.generation,record.valueDigest,JSON.stringify(record.value),record.updatedAt,record.expiresAt ?? null]
        );
      }
      await this.#db.query('COMMIT');
    } catch (error) {
      try { await this.#db.query('ROLLBACK'); } catch {}
      throw error;
    }
  }
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
  return { version: 1, records };
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
    ...(input.expiresAt ? { expiresAt: iso(input.expiresAt,'expiresAt') } : {})
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
    ...(input.expiresAt ? { expiresAt: iso(input.expiresAt,'expiresAt') } : {})
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
  if(Buffer.byteLength(encoded,'utf8')>1024*1024) throw invalid('Control-plane value exceeds 1 MiB.');
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
