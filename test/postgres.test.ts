import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PostgresProvider } from '../src/capabilities/postgres.ts';

async function tempDir(t: test.TestContext, prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function makeFakePsql(t: test.TestContext): Promise<{ executable: string; prefix: string[]; logPath: string }> {
  const dir = await tempDir(t, 'operator-fake-psql-');
  const scriptPath = path.join(dir, 'fake-psql.cjs');
  const logPath = path.join(dir, 'calls.ndjson');
  await fs.writeFile(scriptPath, `
const fs = require('node:fs');
const argv = process.argv.slice(2);
const logPath = ${JSON.stringify(logPath)};
const commandIndex = argv.indexOf('--command');
const sql = commandIndex >= 0 ? argv[commandIndex + 1] : '';
fs.appendFileSync(logPath, JSON.stringify({
  argv,
  sql,
  env: {
    PGHOST: process.env.PGHOST ?? null,
    PGUSER: process.env.PGUSER ?? null,
    PGDATABASE: process.env.PGDATABASE ?? null,
    PGPASSWORD: process.env.PGPASSWORD ? '[present]' : null,
    PGOPTIONS: process.env.PGOPTIONS ?? null,
    PGPASSFILE: process.env.PGPASSFILE ?? null,
    PGSSLMODE: process.env.PGSSLMODE ?? null
  }
}) + '\\n');
if (sql.includes("current_database()")) {
  process.stdout.write('database,user_name,server_version,transaction_read_only\\noperator_test,operator_user,18.6,on\\n');
  process.exit(0);
}
if (sql.includes('information_schema.schemata')) {
  process.stdout.write('schema_name\\ninformation_schema\\npublic\\n');
  process.exit(0);
}
if (sql.includes('information_schema.tables')) {
  process.stdout.write('table_schema,table_name,table_type\\npublic,items,BASE TABLE\\n');
  process.exit(0);
}
if (sql.includes('information_schema.columns')) {
  process.stdout.write('column_name,data_type,is_nullable,ordinal_position\\nid,integer,NO,1\\nnote,text,YES,2\\n');
  process.exit(0);
}
process.stdout.write('id,note,empty_text,nullable\\n1,"hello,world","",\\n2,"line1\\nline2",value,something\\n');
process.exit(0);
`);
  return { executable: process.execPath, prefix: [scriptPath], logPath };
}

async function readCalls(logPath: string): Promise<Array<{ argv: string[]; sql: string; env: Record<string, string | null> }>> {
  try { return (await fs.readFile(logPath, 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)); }
  catch { return []; }
}

async function writeRegistry(file: string, profiles: unknown[]): Promise<void> {
  await fs.writeFile(file, JSON.stringify({ version: 1, profiles }, null, 2));
}

function localProfile(projectRoot: string, overrides: Record<string, unknown> = {}) {
  return {
    id: 'local-dev',
    title: 'Local development database',
    roots: [projectRoot],
    host: '127.0.0.1',
    port: 5432,
    database: 'operator_test',
    user: 'operator_user',
    sslMode: 'disable',
    ...overrides
  };
}

test('PostgreSQL profiles come only from external trusted registry and never expose credentials', async (t) => {
  const projectRoot = await tempDir(t, 'operator-pg-project-');
  const authorityRoot = await tempDir(t, 'operator-pg-authority-');
  const registryPath = path.join(authorityRoot, 'postgres-profiles.json');
  await writeRegistry(registryPath, [localProfile(projectRoot, { passwordEnv: 'OPERATOR_TEST_DB_PASSWORD' })]);
  const fake = await makeFakePsql(t);
  const provider = new PostgresProvider({ allowedRoots: [projectRoot], registryPath, psqlExecutable: fake.executable, psqlArgsPrefix: fake.prefix });

  const result = await provider.execute({
    id: 'pg-profiles', capability: 'postgres.inspect', risk: 'read',
    input: { path: projectRoot, operation: 'profiles' }, provenance: { kind: 'chatgpt' }
  });
  assert.equal(result.ok, true, result.error?.message);
  const output = result.output as any;
  assert.equal(output.profiles.length, 1);
  assert.equal(output.profiles[0].id, 'local-dev');
  assert.equal(output.profiles[0].endpoint, 'loopback');
  assert.equal('passwordEnv' in output.profiles[0], false);
  assert.equal((await readCalls(fake.logPath)).length, 0);
});

test('Structured SELECT keeps malicious values out of SQL text and parses bounded CSV safely', async (t) => {
  const projectRoot = await tempDir(t, 'operator-pg-select-project-');
  const authorityRoot = await tempDir(t, 'operator-pg-select-authority-');
  const registryPath = path.join(authorityRoot, 'postgres-profiles.json');
  await writeRegistry(registryPath, [localProfile(projectRoot)]);
  const fake = await makeFakePsql(t);
  const provider = new PostgresProvider({ allowedRoots: [projectRoot], registryPath, psqlExecutable: fake.executable, psqlArgsPrefix: fake.prefix });
  const malicious = "x'; DROP TABLE users; --";

  const result = await provider.execute({
    id: 'pg-select', capability: 'postgres.select', risk: 'read', provenance: { kind: 'chatgpt' },
    input: {
      path: projectRoot,
      profileId: 'local-dev',
      schema: 'public',
      table: 'items',
      columns: ['id', 'note', 'empty_text', 'nullable'],
      filters: [{ column: 'note', op: 'eq', value: malicious }],
      orderBy: [{ column: 'id', direction: 'asc' }],
      limit: 10
    }
  });
  assert.equal(result.ok, true, result.error?.message);
  const output = result.output as any;
  assert.equal(output.rowCount, 2);
  assert.equal(output.rows[0].note, 'hello,world');
  assert.equal(output.rows[0].empty_text, '');
  assert.equal(output.rows[0].nullable, null);
  assert.equal(output.rows[1].note, 'line1\nline2');

  const calls = await readCalls(fake.logPath);
  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls[0].sql, /DROP TABLE/);
  assert.match(calls[0].sql, /FROM :"op_schema"\.:"op_table"/);
  assert.equal(calls[0].argv.some((arg) => arg === `--set=op_filter_val_0=${malicious}`), true);
  assert.match(String(calls[0].env.PGOPTIONS), /default_transaction_read_only=on/);
  assert.match(String(calls[0].env.PGOPTIONS), /statement_timeout=/);
  assert.equal(calls[0].env.PGHOST, null);
  assert.equal(calls[0].env.PGUSER, null);
  assert.equal(calls[0].env.PGDATABASE, null);
  assert.equal(calls[0].env.PGPASSFILE, os.devNull);
});

test('PostgreSQL fixed metadata inspection uses the same read-only session boundary', async (t) => {
  const projectRoot = await tempDir(t, 'operator-pg-inspect-project-');
  const authorityRoot = await tempDir(t, 'operator-pg-inspect-authority-');
  const registryPath = path.join(authorityRoot, 'postgres-profiles.json');
  await writeRegistry(registryPath, [localProfile(projectRoot)]);
  const fake = await makeFakePsql(t);
  const provider = new PostgresProvider({ allowedRoots: [projectRoot], registryPath, psqlExecutable: fake.executable, psqlArgsPrefix: fake.prefix });

  const result = await provider.execute({
    id: 'pg-columns', capability: 'postgres.inspect', risk: 'read', provenance: { kind: 'chatgpt' },
    input: { path: projectRoot, operation: 'columns', profileId: 'local-dev', schema: 'public', table: 'items' }
  });
  assert.equal(result.ok, true, result.error?.message);
  const output = result.output as any;
  assert.deepEqual(output.rows.map((row: any) => row.column_name), ['id', 'note']);
  const calls = await readCalls(fake.logPath);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /information_schema\.columns/);
  assert.equal(calls[0].argv.some((arg) => arg === '--set=op_schema=public'), true);
  assert.equal(calls[0].argv.some((arg) => arg === '--set=op_table=items'), true);
});

test('PostgreSQL adapter rejects remote hosts and in-project trusted registries before psql execution', async (t) => {
  const projectRoot = await tempDir(t, 'operator-pg-deny-project-');
  const authorityRoot = await tempDir(t, 'operator-pg-deny-authority-');
  const remoteRegistry = path.join(authorityRoot, 'postgres-profiles.json');
  await writeRegistry(remoteRegistry, [localProfile(projectRoot, { id: 'remote-prod', host: 'prod.example.internal' })]);
  const fake = await makeFakePsql(t);
  const remoteProvider = new PostgresProvider({ allowedRoots: [projectRoot], registryPath: remoteRegistry, psqlExecutable: fake.executable, psqlArgsPrefix: fake.prefix });
  const remote = await remoteProvider.execute({
    id: 'pg-remote', capability: 'postgres.inspect', risk: 'read', provenance: { kind: 'chatgpt' },
    input: { path: projectRoot, operation: 'server', profileId: 'remote-prod' }
  });
  assert.equal(remote.ok, false);
  assert.equal(remote.error?.code, 'POSTGRES_REMOTE_HOST_DENIED');
  assert.equal((await readCalls(fake.logPath)).length, 0);

  const insideRegistry = path.join(projectRoot, 'postgres-profiles.json');
  await writeRegistry(insideRegistry, [localProfile(projectRoot)]);
  const insideProvider = new PostgresProvider({ allowedRoots: [projectRoot], registryPath: insideRegistry, psqlExecutable: fake.executable, psqlArgsPrefix: fake.prefix });
  const inside = await insideProvider.execute({
    id: 'pg-inside', capability: 'postgres.inspect', risk: 'read', provenance: { kind: 'chatgpt' },
    input: { path: projectRoot, operation: 'profiles' }
  });
  assert.equal(inside.ok, false);
  assert.equal(inside.error?.code, 'POSTGRES_REGISTRY_INSIDE_PROJECT_DENIED');
});
