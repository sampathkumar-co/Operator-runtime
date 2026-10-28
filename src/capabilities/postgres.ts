import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ActionRequest, ActionResult, CapabilityExecutionContext, CapabilityProvider, CapabilityScore } from '../core/types.ts';
import { evidence } from '../core/evidence.ts';
import { OperatorError } from '../core/errors.ts';
import { resolveTrustedExecutable } from '../core/trusted-executable.ts';
import { readDurableStateText } from '../core/durable-state.ts';
import { PathScope } from './path-scope.ts';

const SCORE: CapabilityScore = {
  reliability: 0.98,
  latency: 0.9,
  determinism: 0.99,
  security: 0.98,
  reversibility: 1,
  informationQuality: 0.99,
  interactionCost: 0.01
};

const MAX_REGISTRY_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_PROFILES = 50;
const MAX_ROWS = 500;
const MAX_COLUMNS = 50;
const MAX_FILTERS = 20;
const POSTGRES_REGISTRY_OPTIONS = {
  maxBytes: MAX_REGISTRY_BYTES,
  errorCode: 'POSTGRES_REGISTRY_INVALID',
  invalidMessage: 'PostgreSQL profile registry is invalid.'
} as const;

type Profile = {
  id: string;
  title?: string;
  roots: string[];
  host: string;
  port: number;
  database: string;
  user: string;
  passwordEnv?: string;
  sslMode: 'disable' | 'prefer' | 'require';
};

type Registry = { version: 1; profiles: Profile[] };
type PsqlOutput = { stdout: string; stderr: string; code: number; truncated: boolean };

type Filter = {
  column: string;
  op: 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte' | 'like' | 'ilike' | 'is_null' | 'not_null';
  value?: string;
};

type Order = { column: string; direction: 'asc' | 'desc' };

export class PostgresProvider implements CapabilityProvider {
  readonly name = 'postgres.psql.structured';
  #scope: PathScope;
  #allowedRoots: string[];
  #registryPath: string;
  #psqlExecutable: string;
  #psqlArgsPrefix: string[];

  constructor(options: { allowedRoots: string[]; registryPath?: string; psqlExecutable?: string; psqlArgsPrefix?: string[] }) {
    this.#scope = new PathScope(options.allowedRoots);
    this.#allowedRoots = options.allowedRoots.map((root) => path.resolve(root));
    this.#registryPath = path.resolve(options.registryPath ?? path.join(os.homedir(), '.operator', 'postgres-profiles.json'));
    this.#psqlExecutable = options.psqlExecutable ?? 'psql';
    this.#psqlArgsPrefix = options.psqlArgsPrefix ?? [];
  }

  supports(action: ActionRequest): boolean {
    return action.capability === 'postgres.inspect' || action.capability === 'postgres.select';
  }

  score(): CapabilityScore { return SCORE; }

  async execute(action: ActionRequest, context: CapabilityExecutionContext = {}): Promise<ActionResult> {
    const started = performance.now();
    try {
      if (!this.supports(action)) throw new OperatorError('UNSUPPORTED_ACTION', 'PostgreSQL provider does not support the requested capability.');
      if (typeof action.input.path !== 'string' || !action.input.path || action.input.path.length > 4096) {
        throw new OperatorError('POSTGRES_PROJECT_SCOPE_INVALID', 'A typed, bounded authorized project path is required.');
      }
      const root = await this.#scope.resolveExisting(action.input.path);
      const registry = await this.#readRegistry();
      const authorized = await this.#profilesForRoot(registry, root);

      if (action.capability === 'postgres.inspect') {
        const operation = action.input.operation === undefined ? 'profiles' : action.input.operation;
        if (typeof operation !== 'string') throw new OperatorError('INVALID_POSTGRES_INSPECT_OPERATION', 'PostgreSQL inspect operation must be an exact string.');
        if (operation === 'profiles') {
          return success(action, started, {
            root,
            profiles: authorized.map((profile) => ({
              id: profile.id,
              title: profile.title,
              database: profile.database,
              user: profile.user,
              endpoint: endpointClass(profile.host),
              port: profile.port,
              sslMode: profile.sslMode
            }))
          }, [evidence('postgres_profiles', 'pass', 'Returned only trusted PostgreSQL profiles bound to this authorized project root; credentials were not returned.', {
            profileCount: authorized.length
          })]);
        }

        const profile = this.#chooseProfile(authorized, action.input.profileId);
        const timeoutMs = boundedTimeout(action.input.timeoutMs);
        if (operation === 'server') {
          const rows = await this.#query(profile, root,
            "SELECT current_database() AS database, current_user AS user_name, current_setting('server_version') AS server_version, current_setting('transaction_read_only') AS transaction_read_only",
            {}, timeoutMs, context.signal);
          return success(action, started, { profileId: profile.id, operation, rows }, [readOnlyEvidence(profile, operation)]);
        }
        if (operation === 'schemas') {
          const rows = await this.#query(profile, root,
            "SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT LIKE 'pg_toast%' ORDER BY schema_name LIMIT 200",
            {}, timeoutMs, context.signal);
          return success(action, started, { profileId: profile.id, operation, rows }, [readOnlyEvidence(profile, operation)]);
        }
        if (operation === 'tables') {
          const schema = identifier((action.input.schema ?? 'public'), 'schema');
          const rows = await this.#query(profile, root,
            "SELECT table_schema, table_name, table_type FROM information_schema.tables WHERE table_schema = :'op_schema' ORDER BY table_name LIMIT 500",
            { op_schema: schema }, timeoutMs, context.signal);
          return success(action, started, { profileId: profile.id, operation, schema, rows }, [readOnlyEvidence(profile, operation)]);
        }
        if (operation === 'columns') {
          const schema = identifier((action.input.schema ?? 'public'), 'schema');
          const table = identifier(action.input.table, 'table');
          const rows = await this.#query(profile, root,
            "SELECT column_name, data_type, is_nullable, ordinal_position FROM information_schema.columns WHERE table_schema = :'op_schema' AND table_name = :'op_table' ORDER BY ordinal_position LIMIT 500",
            { op_schema: schema, op_table: table }, timeoutMs, context.signal);
          return success(action, started, { profileId: profile.id, operation, schema, table, rows }, [readOnlyEvidence(profile, operation)]);
        }
        throw new OperatorError('INVALID_POSTGRES_INSPECT_OPERATION', 'operation must be profiles, server, schemas, tables, or columns.');
      }

      const profile = this.#chooseProfile(authorized, action.input.profileId);
      const schema = identifier((action.input.schema ?? 'public'), 'schema');
      const table = identifier(action.input.table, 'table');
      const columns = validateColumns(action.input.columns);
      const filters = validateFilters(action.input.filters);
      const orderBy = validateOrder(action.input.orderBy);
      const limit = boundedInteger(action.input.limit, 100, 1, MAX_ROWS);
      const offset = boundedInteger(action.input.offset, 0, 0, 10_000);
      const timeoutMs = boundedTimeout(action.input.timeoutMs);
      const maxBytes = boundedInteger(action.input.maxBytes, 64 * 1024, 1024, 128 * 1024);
      const built = buildSelect(schema, table, columns, filters, orderBy, limit, offset);
      const rows = await this.#query(profile, root, built.sql, built.variables, timeoutMs, context.signal);
      const boundedRows = boundSerializedRows(rows, maxBytes);
      if (rows.length > 0 && boundedRows.rows.length === 0) {
        throw new OperatorError('POSTGRES_ROW_TOO_LARGE', 'The first PostgreSQL row cannot fit the authorized response byte budget; pagination cannot advance.');
      }
      return success(action, started, {
        profileId: profile.id,
        schema,
        table,
        columns: columns.length === 0 ? ['*'] : columns,
        rowCount: boundedRows.rows.length,
        queriedRowCount: rows.length,
        limit,
        offset,
        maxBytes,
        rows: boundedRows.rows,
        truncated: boundedRows.truncated,
        ...(boundedRows.truncated ? { nextOffset: offset + boundedRows.rows.length } : {})
      }, [
        evidence('postgres_read_only', 'pass', 'Executed an Operator-constructed structured SELECT under a server-enforced read-only session with statement/lock timeouts.', {
          profileId: profile.id,
          rowCount: boundedRows.rows.length,
          filterCount: filters.length,
          orderCount: orderBy.length
        }),
        evidence('postgres_parameters', 'pass', 'Identifiers and filter values were passed through psql quoted-variable interpolation rather than concatenated into SQL text.', {
          variableCount: Object.keys(built.variables).length
        })
      ]);
    } catch (error) {
      const op = error instanceof OperatorError
        ? error
        : new OperatorError('POSTGRES_ERROR', error instanceof Error ? error.message : String(error), { retryable: true });
      return {
        ok: false,
        capability: action.capability,
        provider: this.name,
        evidence: [evidence('postgres', 'fail', op.message, { code: op.code })],
        error: {
          code: op.code,
          message: op.message,
          retryable: op.retryable,
          ...(op.details && ['none', 'known', 'uncertain'].includes(String(op.details.sideEffectState)) ? { sideEffectState: op.details.sideEffectState as 'none' | 'known' | 'uncertain' } : {}),
          ...(op.details ? { details: structuredClone(op.details) } : {})
        },
        durationMs: Math.round(performance.now() - started)
      };
    }
  }

  async #readRegistry(): Promise<Registry | null> {
    let realRegistry: string;
    try {
      realRegistry = await fs.realpath(this.#registryPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }

    for (const root of this.#allowedRoots) {
      let realRoot = root;
      try { realRoot = await fs.realpath(root); } catch { /* retain lexical root */ }
      if (isWithin(this.#registryPath, root) || isWithin(realRegistry, realRoot)) {
        throw new OperatorError('POSTGRES_REGISTRY_INSIDE_PROJECT_DENIED', 'Trusted PostgreSQL profile registry must live outside all authorized project roots.');
      }
    }

    let raw: string;
    try {
      raw = await readDurableStateText(this.#registryPath, POSTGRES_REGISTRY_OPTIONS);
    } catch (error) {
      if (error instanceof OperatorError) throw error;
      throw new OperatorError('POSTGRES_REGISTRY_INVALID', 'PostgreSQL profile registry could not be read.', {
        details: { cause: String(error) }
      });
    }

    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch {
      throw new OperatorError('POSTGRES_REGISTRY_INVALID', 'PostgreSQL profile registry is not valid JSON.');
    }
    return validateRegistry(parsed);
  }

  async #profilesForRoot(registry: Registry | null, root: string): Promise<Profile[]> {
    if (!registry) return [];
    const matched: Profile[] = [];
    for (const profile of registry.profiles) {
      for (const configuredRoot of profile.roots) {
        try {
          const canonical = await this.#scope.resolveExisting(configuredRoot);
          if (canonical === root) { matched.push(profile); break; }
        } catch { /* profile belongs to a root not authorized in this agent */ }
      }
    }
    return matched;
  }

  #chooseProfile(profiles: Profile[], profileId: unknown): Profile {
    if (typeof profileId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(profileId)) {
      throw new OperatorError('POSTGRES_PROFILE_ID_REQUIRED', 'A profileId from postgres.inspect profiles is required.');
    }
    const profile = profiles.find((candidate) => candidate.id === profileId);
    if (!profile) throw new OperatorError('POSTGRES_PROFILE_NOT_AUTHORIZED', 'PostgreSQL profile is not registered for this authorized project root.');
    if (!isLocalPostgresHost(profile.host)) {
      throw new OperatorError('POSTGRES_REMOTE_HOST_DENIED', 'This certified PostgreSQL adapter permits only loopback TCP or local Unix-socket profiles.', {
        details: { profileId: profile.id, endpoint: endpointClass(profile.host) }
      });
    }
    return profile;
  }

  async #query(profile: Profile, cwd: string, sql: string, variables: Record<string, string>, timeoutMs: number, signal?: AbortSignal): Promise<Array<Record<string, string | null>>> {
    const args = [
      ...this.#psqlArgsPrefix,
      '-X',
      '--csv',
      '--quiet',
      '--no-password',
      '--set=ON_ERROR_STOP=1',
      `--host=${profile.host}`,
      `--port=${profile.port}`,
      `--dbname=${profile.database}`,
      `--username=${profile.user}`
    ];
    for (const [name, value] of Object.entries(variables)) {
      if (value.includes('\0')) throw new OperatorError('POSTGRES_PARAMETER_INVALID', 'PostgreSQL query parameters cannot contain NUL bytes.');
      args.push(`--set=${name}=${value}`);
    }
    // psql -c/--command bypasses client-side :variable interpolation. Read the
    // fixed, bounded SQL template through psql's stdin parser instead.
    args.push('--file=-');
    const output = await runPsql(this.#psqlExecutable, args, cwd, profile, timeoutMs, signal, sql);
    if (output.truncated) throw new OperatorError('POSTGRES_OUTPUT_TOO_LARGE', 'PostgreSQL output exceeded the bounded response size.');
    return parseCsvObjects(output.stdout, MAX_ROWS);
  }
}

function validateRegistry(input: unknown): Registry {
  if (!input || typeof input !== 'object') throw new OperatorError('POSTGRES_REGISTRY_INVALID', 'PostgreSQL profile registry must be an object.');
  const raw = input as Record<string, unknown>;
  if (raw.version !== 1 || !Array.isArray(raw.profiles) || raw.profiles.length > MAX_PROFILES) {
    throw new OperatorError('POSTGRES_REGISTRY_INVALID', `PostgreSQL registry requires version=1 and at most ${MAX_PROFILES} profiles.`);
  }
  const seen = new Set<string>();
  const profiles = raw.profiles.map((entry, index): Profile => {
    if (!entry || typeof entry !== 'object') throw new OperatorError('POSTGRES_REGISTRY_INVALID', `Profile ${index} is invalid.`);
    const value = entry as Record<string, unknown>;
    const id = value.id;
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id) || seen.has(id)) throw new OperatorError('POSTGRES_REGISTRY_INVALID', `Profile ${index} id is invalid or duplicated.`);
    seen.add(id);
    const roots: string[] = Array.isArray(value.roots) && value.roots.every(root => typeof root === 'string') ? value.roots : [];
    if (roots.length === 0 || roots.length > 20 || roots.some((root) => typeof root !== 'string' || !path.isAbsolute(root))) {
      throw new OperatorError('POSTGRES_REGISTRY_INVALID', `Profile ${id} requires 1-20 absolute project roots.`);
    }
    const host = boundedText(value.host, 512, `Profile ${id} host`);
    const port = value.port === undefined ? 5432 : value.port;
    if (typeof port !== 'number' || !Number.isSafeInteger(port) || port < 1 || port > 65535) throw new OperatorError('POSTGRES_REGISTRY_INVALID', `Profile ${id} port is invalid.`);
    const database = boundedText(value.database, 128, `Profile ${id} database`);
    const user = boundedText(value.user, 128, `Profile ${id} user`);
    const passwordEnv = value.passwordEnv;
    if (passwordEnv !== undefined && (typeof passwordEnv !== 'string' || !/^[A-Z_][A-Z0-9_]{0,127}$/.test(passwordEnv))) throw new OperatorError('POSTGRES_REGISTRY_INVALID', `Profile ${id} passwordEnv is invalid.`);
    const sslMode = value.sslMode === undefined ? 'prefer' : value.sslMode;
    if (typeof sslMode !== 'string' || !['disable', 'prefer', 'require'].includes(sslMode)) throw new OperatorError('POSTGRES_REGISTRY_INVALID', `Profile ${id} sslMode is invalid.`);
    const title = typeof value.title === 'string' ? value.title.trim().slice(0, 160) || undefined : undefined;
    return { id, title, roots: roots.map((root) => path.resolve(root)), host, port, database, user, passwordEnv, sslMode: sslMode as Profile['sslMode'] };
  });
  return { version: 1, profiles };
}

function validateColumns(input: unknown): string[] {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > MAX_COLUMNS) throw new OperatorError('POSTGRES_COLUMNS_INVALID', `columns must contain at most ${MAX_COLUMNS} identifiers.`);
  const columns = input.map((value) => identifier(value, 'column'));
  if (new Set(columns).size !== columns.length) throw new OperatorError('POSTGRES_COLUMNS_INVALID', 'Duplicate selected columns are not allowed.');
  return columns;
}

function validateFilters(input: unknown): Filter[] {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > MAX_FILTERS) throw new OperatorError('POSTGRES_FILTERS_INVALID', `filters must contain at most ${MAX_FILTERS} entries.`);
  return input.map((entry, index) => {
    if (!entry || typeof entry !== 'object') throw new OperatorError('POSTGRES_FILTERS_INVALID', `Filter ${index} is invalid.`);
    const raw = entry as Record<string, unknown>;
    const column = identifier(raw.column, `filter ${index} column`);
    const op = (raw.op === undefined ? 'eq' : raw.op) as Filter['op'];
    if (!['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'like', 'ilike', 'is_null', 'not_null'].includes(op)) throw new OperatorError('POSTGRES_FILTERS_INVALID', `Filter ${index} operator is invalid.`);
    if (op === 'is_null' || op === 'not_null') return { column, op };
    const rawValue = raw.value;
    if (!((typeof rawValue === 'string') ||
          (typeof rawValue === 'number' && Number.isFinite(rawValue)) ||
          typeof rawValue === 'boolean')) {
      throw new OperatorError('POSTGRES_PARAMETER_INVALID', `Filter ${index} requires a typed scalar value.`);
    }
    const value = String(rawValue);
    if (value.includes('\0') || value.length > 100_000) throw new OperatorError('POSTGRES_PARAMETER_INVALID', `Filter ${index} value exceeds bounds.`);
    return { column, op, value };
  });
}

function validateOrder(input: unknown): Order[] {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > 5) throw new OperatorError('POSTGRES_ORDER_INVALID', 'orderBy must contain at most 5 entries.');
  return input.map((entry, index) => {
    if (!entry || typeof entry !== 'object') throw new OperatorError('POSTGRES_ORDER_INVALID', `Order ${index} is invalid.`);
    const raw = entry as Record<string, unknown>;
    const column = identifier(raw.column, `order ${index} column`);
    const direction = raw.direction === undefined ? 'asc' : typeof raw.direction === 'string' ? raw.direction.toLowerCase() : '';
    if (direction !== 'asc' && direction !== 'desc') throw new OperatorError('POSTGRES_ORDER_INVALID', `Order ${index} direction is invalid.`);
    return { column, direction } as Order;
  });
}

function buildSelect(schema: string, table: string, columns: string[], filters: Filter[], orderBy: Order[], limit: number, offset: number): { sql: string; variables: Record<string, string> } {
  const variables: Record<string, string> = { op_schema: schema, op_table: table };
  const selectList = columns.length === 0 ? '*' : columns.map((column, index) => {
    const name = `op_col_${index}`;
    variables[name] = column;
    return `:"${name}"`;
  }).join(', ');
  const clauses = filters.map((filter, index) => {
    const columnName = `op_filter_col_${index}`;
    variables[columnName] = filter.column;
    if (filter.op === 'is_null') return `:"${columnName}" IS NULL`;
    if (filter.op === 'not_null') return `:"${columnName}" IS NOT NULL`;
    const valueName = `op_filter_val_${index}`;
    variables[valueName] = filter.value ?? '';
    const operators: Record<Exclude<Filter['op'], 'is_null' | 'not_null'>, string> = {
      eq: '=', ne: '<>', lt: '<', lte: '<=', gt: '>', gte: '>=', like: 'LIKE', ilike: 'ILIKE'
    };
    return `:"${columnName}" ${operators[filter.op]} :'${valueName}'`;
  });
  const ordering = orderBy.map((order, index) => {
    const name = `op_order_${index}`;
    variables[name] = order.column;
    return `:"${name}" ${order.direction.toUpperCase()}`;
  });
  let sql = `SELECT ${selectList} FROM :"op_schema".:"op_table"`;
  if (clauses.length > 0) sql += ` WHERE ${clauses.join(' AND ')}`;
  if (ordering.length > 0) sql += ` ORDER BY ${ordering.join(', ')}`;
  sql += ` LIMIT ${limit} OFFSET ${offset}`;
  return { sql, variables };
}

function boundedText(value: unknown, max: number, label: string): string {
  if (typeof value !== 'string') throw new OperatorError('POSTGRES_REGISTRY_INVALID', `${label} must be a literal string.`);
  const text = value;
  if (!text || text.length > max || /[\0\r\n]/.test(text)) throw new OperatorError('POSTGRES_REGISTRY_INVALID', `${label} is invalid.`);
  return text;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value.length > 128 || /[\0\r\n]/.test(value)) throw new OperatorError('POSTGRES_IDENTIFIER_INVALID', `${label} identifier is invalid.`);
  return value;
}

function boundedTimeout(value: unknown): number {
  return boundedInteger(value, 5_000, 250, 10_000);
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new OperatorError('POSTGRES_BUDGET_INVALID', 'PostgreSQL row/offset/byte/timeout budget must be an exact bounded integer.');
  }
  return value;
}

function isLocalPostgresHost(host: string): boolean {
  if (path.isAbsolute(host)) return true;
  const normalized = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (normalized === 'localhost' || normalized === '::1') return true;
  return /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function endpointClass(host: string): string {
  if (path.isAbsolute(host)) return 'unix_socket';
  return isLocalPostgresHost(host) ? 'loopback' : 'remote';
}

function readOnlyEvidence(profile: Profile, operation: string) {
  return evidence('postgres_read_only', 'pass', 'Executed fixed PostgreSQL metadata inspection under a server-enforced read-only session.', {
    profileId: profile.id,
    operation,
    endpoint: endpointClass(profile.host)
  });
}

function isWithin(candidate: string, root: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function psqlEnvironment(profile: Profile, timeoutMs: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PGPASSFILE: os.devNull,
    PGSSLMODE: profile.sslMode,
    PGOPTIONS: `-c default_transaction_read_only=on -c statement_timeout=${timeoutMs} -c lock_timeout=${Math.min(timeoutMs, 2000)}`
  };
  for (const key of ['PATH', 'Path', 'SYSTEMROOT', 'WINDIR', 'TMP', 'TEMP']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  if (profile.passwordEnv) {
    const password = process.env[profile.passwordEnv];
    if (password === undefined) throw new OperatorError('POSTGRES_PASSWORD_ENV_MISSING', `Password environment variable configured for profile ${profile.id} is not set.`);
    env.PGPASSWORD = password;
  }
  return env;
}

async function runPsql(executable: string, args: string[], cwd: string, profile: Profile, timeoutMs: number, signal: AbortSignal | undefined, sql: string): Promise<PsqlOutput> {
  return await new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new OperatorError('EXECUTION_ABORTED', 'PostgreSQL execution was cancelled.', { retryable: false }));
      return;
    }
    const environment = psqlEnvironment(profile, timeoutMs);
    const psqlExecutable = resolveTrustedExecutable(executable, environment);
    const child = spawn(psqlExecutable, args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: environment
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    let timedOut = false;
    let aborted = false;
    let forceKillTimer: NodeJS.Timeout | undefined;
    const capture = (bucket: Buffer[]) => (chunk: Buffer) => {
      if (bytes >= MAX_OUTPUT_BYTES) { truncated = true; return; }
      const sliced = chunk.subarray(0, MAX_OUTPUT_BYTES - bytes);
      bucket.push(sliced);
      bytes += sliced.byteLength;
      if (sliced.byteLength < chunk.byteLength) truncated = true;
    };
    child.stdout.on('data', capture(stdout));
    child.stderr.on('data', capture(stderr));
    // The SQL template contains only server-generated identifier/value placeholders;
    // actual values stay in psql's --set variables and cannot become meta-commands.
    // Early child exit may close stdin first; the process exit code still fails closed.
    child.stdin.on('error', () => {});
    child.stdin.end(sql + '\n', 'utf8');
    child.once('error', reject);
    const terminate = () => {
      try { child.kill('SIGTERM'); } catch { /* child may already be gone */ }
      if (!forceKillTimer) {
        forceKillTimer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* child may already be gone */ }
        }, 1000);
        forceKillTimer.unref();
      }
    };
    const onAbort = () => { aborted = true; terminate(); };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs + 1500);
    timer.unref();
    child.once('close', (code) => {
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      signal?.removeEventListener('abort', onAbort);
      if (aborted) {
        reject(new OperatorError('EXECUTION_ABORTED', 'PostgreSQL execution was cancelled.', { retryable: false }));
        return;
      }
      if (timedOut) {
        reject(new OperatorError('POSTGRES_TIMEOUT', `PostgreSQL command exceeded ${timeoutMs}ms statement window.`, { retryable: true }));
        return;
      }
      const output = {
        code: code ?? -1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        truncated
      };
      if (output.code !== 0) {
        reject(new OperatorError('POSTGRES_QUERY_FAILED', output.stderr.trim().slice(0, 1600) || `psql exited with code ${output.code}.`));
        return;
      }
      resolve(output);
    });
  });
}

export function parseCsvObjects(csv: string, maxRows: number): Array<Record<string, string | null>> {
  if (typeof csv !== 'string' || Buffer.byteLength(csv, 'utf8') > MAX_OUTPUT_BYTES ||
      !Number.isSafeInteger(maxRows) || maxRows < 0 || maxRows > MAX_ROWS) {
    throw new OperatorError('POSTGRES_CSV_INVALID', 'PostgreSQL CSV parse input or row budget is invalid.');
  }
  if (csv.length === 0) return [];

  // Strict CSV state machine: an unquoted empty field is SQL NULL and a
  // quoted empty field is an actual empty string. A row consisting of just
  // an unquoted empty field is still a row, never a discardable blank line.
  type Cell = { value: string; quoted: boolean };
  const records: Cell[][] = [];
  let row: Cell[] = [];
  let field = '';
  let quoted = false;
  let state: 'start' | 'unquoted' | 'quoted' | 'after_quote' = 'start';
  const pushField = () => {
    row.push({ value: field, quoted });
    field = '';
    quoted = false;
    state = 'start';
  };
  const pushRow = () => {
    pushField();
    records.push(row);
    if (records.length > maxRows + 1) {
      throw new OperatorError('POSTGRES_ROW_LIMIT_EXCEEDED',
        'PostgreSQL returned more rows than the configured bound.');
    }
    row = [];
  };

  for (let index = 0; index < csv.length; index += 1) {
    const char = csv[index]!;
    if (state === 'quoted') {
      if (char === '"') {
        if (csv[index + 1] === '"') { field += '"'; index += 1; }
        else state = 'after_quote';
      } else {
        field += char;
      }
      continue;
    }
    if (char === ',') { pushField(); continue; }
    if (char === '\n' || char === '\r') {
      if (char === '\r' && csv[index + 1] === '\n') index += 1;
      pushRow();
      continue;
    }
    if (state === 'after_quote') {
      throw new OperatorError('POSTGRES_CSV_INVALID',
        'Unexpected data after a closed PostgreSQL CSV quoted field.');
    }
    if (char === '"') {
      if (state !== 'start') {
        throw new OperatorError('POSTGRES_CSV_INVALID',
          'Unexpected quote inside an unquoted PostgreSQL CSV field.');
      }
      state = 'quoted';
      quoted = true;
      continue;
    }
    field += char;
    state = 'unquoted';
  }
  if (state === 'quoted') {
    throw new OperatorError('POSTGRES_CSV_INVALID', 'PostgreSQL CSV output ended inside a quoted field.');
  }
  if (state !== 'start' || row.length > 0) pushRow();
  if (records.length === 0) return [];

  const headers = records[0]!.map((cell) => cell.value);
  if (headers.some((header) => !header || header.length > 256) || new Set(headers).size !== headers.length) {
    throw new OperatorError('POSTGRES_CSV_INVALID', 'PostgreSQL CSV headers are invalid or duplicated.');
  }
  return records.slice(1).map((record) => {
    if (record.length !== headers.length) {
      throw new OperatorError('POSTGRES_CSV_INVALID', 'PostgreSQL CSV row width does not match headers.');
    }
    const object: Record<string, string | null> = Object.create(null);
    for (let index = 0; index < headers.length; index += 1) {
      const cell = record[index]!;
      object[headers[index]!] = cell.value === '' && !cell.quoted ? null : cell.value;
    }
    return object;
  });
}

function boundSerializedRows(rows: Array<Record<string, string | null>>, maxBytes: number): { rows: Array<Record<string, string | null>>; truncated: boolean } {
  const bounded: Array<Record<string, string | null>> = [];
  let bytes = 2;
  for (const row of rows) {
    const rowBytes = Buffer.byteLength(JSON.stringify(row), 'utf8') + (bounded.length > 0 ? 1 : 0);
    if (bytes + rowBytes > maxBytes) break;
    bounded.push(row);
    bytes += rowBytes;
  }
  return { rows: bounded, truncated: bounded.length < rows.length };
}

function success(action: ActionRequest, started: number, output: unknown, extraEvidence: ReturnType<typeof evidence>[]): ActionResult {
  return {
    ok: true,
    capability: action.capability,
    provider: 'postgres.psql.structured',
    output,
    evidence: extraEvidence,
    durationMs: Math.round(performance.now() - started)
  };
}
