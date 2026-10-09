import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { applyControlPlaneMigration, EmbeddedControlPlaneStore, PostgresControlPlaneStore, purgeExpiredControlPlaneRecords, type ControlPlaneStore, type PostgresQueryClient } from '../src/core/control-plane-store.ts';
import { RelayClusterCoordinator } from '../src/core/relay-cluster-control.ts';
import { OperatorError } from '../src/core/errors.ts';

test('control-plane CAS rejects stale writers atomically', async (t)=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mecord-cp-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const store=new EmbeddedControlPlaneStore(dir);
  const [first]=await store.transact([{namespace:'n',key:'k',expectedGeneration:null,value:{v:1}}],'2026-10-07T00:00:00.000Z');
  await assert.rejects(store.transact([{namespace:'n',key:'k',expectedGeneration:first!.generation+1,value:{v:2}}],'2026-10-07T00:00:01.000Z'),(e:any)=>e?.code==='CONTROL_PLANE_CAS_MISMATCH');
  assert.equal((await store.get('n','k'))?.value.v,1);
});

test('snapshot restore is digest-bound and coherent', async (t)=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mecord-cp-snap-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const store=new EmbeddedControlPlaneStore(dir);
  await store.transact([{namespace:'a',key:'1',expectedGeneration:null,value:{x:'one'}},{namespace:'a',key:'2',expectedGeneration:null,value:{x:'two'}}],'2026-10-07T00:00:00.000Z');
  const snap=await store.snapshot('2026-10-07T00:00:01.000Z');
  const first=(await store.get('a','1'))!;
  await store.transact([{namespace:'a',key:'1',expectedGeneration:first.generation,value:{x:'changed'}}],'2026-10-07T00:00:02.000Z');
  await assert.rejects(store.restore(snap),(e:any)=>e?.code==='CONTROL_PLANE_RESTORE_CONFLICT');

  const restoredDir=await fs.mkdtemp(path.join(os.tmpdir(),'mecord-cp-restore-'));
  t.after(()=>fs.rm(restoredDir,{recursive:true,force:true}));
  const restored=new EmbeddedControlPlaneStore(restoredDir);
  await restored.restore(snap);
  assert.equal((await restored.get('a','1'))?.value.x,'one');

  const tampered=structuredClone(snap);tampered.records[0]!.value={x:'evil'};
  const tamperedDir=await fs.mkdtemp(path.join(os.tmpdir(),'mecord-cp-tampered-'));
  t.after(()=>fs.rm(tamperedDir,{recursive:true,force:true}));
  await assert.rejects(new EmbeddedControlPlaneStore(tamperedDir).restore(tampered),(e:any)=>e?.code==='CONTROL_PLANE_STORE_INVALID'||e?.code==='CONTROL_PLANE_STORE_CORRUPT');
});

test('relay cluster coordinator fences split brain and allows handoff after release', async (t)=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mecord-cluster-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const store=new EmbeddedControlPlaneStore(dir);
  const cluster=new RelayClusterCoordinator(store);
  const one=await cluster.acquire('device:1','relay-a',30_000,'2026-10-07T00:00:00.000Z');
  await assert.rejects(cluster.acquire('device:1','relay-b',30_000,'2026-10-07T00:00:01.000Z'),(e:any)=>e?.code==='RELAY_CLUSTER_RESOURCE_FENCED');
  await cluster.release(one,'2026-10-07T00:00:02.000Z');
  const two=await cluster.acquire('device:1','relay-b',30_000,'2026-10-07T00:00:03.000Z');
  assert.equal(two.instanceId,'relay-b');
  assert.ok(two.generation>=1);
  await assert.rejects(cluster.assertCurrent(one,'2026-10-07T00:00:04.000Z'),(e:any)=>e?.code==='RELAY_CLUSTER_FENCE_STALE'||e?.code==='RELAY_CLUSTER_FENCE_LOST');
});


test('control-plane migration is atomic and idempotent', async (t)=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mecord-cp-migrate-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const store=new EmbeddedControlPlaneStore(dir);
  const migration={id:'r5-v1',mutations:[{namespace:'settings',key:'slo',expectedGeneration:null,value:{enabled:true}}]};
  assert.equal(await applyControlPlaneMigration(store,migration,'2026-10-07T00:00:00.000Z'),true);
  assert.equal(await applyControlPlaneMigration(store,migration,'2026-10-07T00:00:01.000Z'),false);
  assert.equal((await store.get('settings','slo'))?.value.enabled,true);
});

test('retention purge removes only expired generation-matched records', async (t)=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mecord-cp-retain-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const store=new EmbeddedControlPlaneStore(dir);
  await store.transact([
    {namespace:'leases',key:'expired',expectedGeneration:null,value:{owner:'a'},expiresAt:'2026-10-07T00:00:05.000Z'},
    {namespace:'leases',key:'live',expectedGeneration:null,value:{owner:'b'},expiresAt:'2026-10-07T00:01:00.000Z'}
  ],'2026-10-07T00:00:00.000Z');
  assert.equal(await purgeExpiredControlPlaneRecords(store,'leases','2026-10-07T00:00:10.000Z'),1);
  assert.equal(await store.get('leases','expired'),null);
  assert.equal((await store.get('leases','live'))?.value.owner,'b');
});


test('Postgres control plane pins transactions to one connection and never recycles expired generations', async () => {
  let released=0;
  let begins=0,commits=0,rollbacks=0;
  let row:{generation:number;expires_at:string|null}|undefined={generation:5,expires_at:'2026-10-07T00:00:05.000Z'};
  const client:PostgresQueryClient={
    async query(text:string,values?:unknown[]){
      if(text==='BEGIN'){begins+=1;return{rows:[]};}
      if(text==='COMMIT'){commits+=1;return{rows:[]};}
      if(text==='ROLLBACK'){rollbacks+=1;return{rows:[]};}
      if(text.startsWith('SELECT pg_advisory_xact_lock')) return{rows:[]};
      if(text.startsWith('SELECT generation, expires_at')) return{rows:row?[{...row}]:[]};
      if(text.startsWith('INSERT INTO mecord_control_plane')){
        row={generation:Number(values?.[2]),expires_at:(values?.[6] as string|null)??null};
        return{rows:[],rowCount:1};
      }
      if(text.startsWith('DELETE FROM mecord_control_plane')){row=undefined;return{rows:[],rowCount:1};}
      throw new Error('unexpected pinned query: '+text);
    },
    release(){released+=1;}
  };
  const pool={
    async query(){throw new Error('transaction must not run through pool.query');},
    async connect(){return client;}
  };
  const store=new PostgresControlPlaneStore(pool);
  const [created]=await store.transact([
    {namespace:'leases',key:'device:1',expectedGeneration:null,value:{owner:'relay-b'},expiresAt:'2026-10-07T00:01:00.000Z'}
  ],'2026-10-07T00:00:10.000Z');
  assert.equal(created?.generation,6);
  assert.equal(row?.generation,6);
  assert.equal(begins,1);
  assert.equal(commits,1);
  assert.equal(rollbacks,0);
  assert.equal(released,1);
});

test('Postgres pooled transaction rolls back and releases its pinned connection on CAS failure', async () => {
  let released=0,rollbacks=0;
  const client:PostgresQueryClient={
    async query(text:string){
      if(text==='BEGIN'||text==='COMMIT')return{rows:[]};
      if(text==='ROLLBACK'){rollbacks+=1;return{rows:[]};}
      if(text.startsWith('SELECT pg_advisory_xact_lock'))return{rows:[]};
      if(text.startsWith('SELECT generation, expires_at'))return{rows:[{generation:9,expires_at:null}]};
      throw new Error('unexpected query');
    },
    release(){released+=1;}
  };
  const store=new PostgresControlPlaneStore({
    async query(){throw new Error('pool query must not own transaction');},
    async connect(){return client;}
  });
  await assert.rejects(
    store.transact([{namespace:'n',key:'k',expectedGeneration:8,value:{v:2}}],'2026-10-07T00:00:10.000Z'),
    (error:any)=>error?.code==='CONTROL_PLANE_CAS_MISMATCH'
  );
  assert.equal(rollbacks,1);
  assert.equal(released,1);
});


test('Postgres create-if-absent CAS acquires transaction advisory fences before row inspection', async () => {
  const calls:string[]=[];
  const client:PostgresQueryClient={
    async query(text:string){
      calls.push(text);
      if(text==='BEGIN'||text==='COMMIT'||text==='ROLLBACK')return{rows:[]};
      if(text.startsWith('SELECT pg_advisory_xact_lock'))return{rows:[]};
      if(text.startsWith('SELECT generation, expires_at'))return{rows:[]};
      if(text.startsWith('INSERT INTO mecord_control_plane'))return{rows:[],rowCount:1};
      throw new Error('unexpected query: '+text);
    }
  };
  const store=new PostgresControlPlaneStore(client);
  await store.transact([
    {namespace:'n',key:'b',expectedGeneration:null,value:{v:2}},
    {namespace:'n',key:'a',expectedGeneration:null,value:{v:1}}
  ],'2026-10-07T00:00:10.000Z');
  const firstRowLookup=calls.findIndex((text)=>text.startsWith('SELECT generation, expires_at'));
  const advisoryCalls=calls.filter((text)=>text.startsWith('SELECT pg_advisory_xact_lock'));
  assert.equal(advisoryCalls.length,2);
  assert.ok(firstRowLookup>0);
  assert.ok(calls.slice(0,firstRowLookup).filter((text)=>text.startsWith('SELECT pg_advisory_xact_lock')).length===2);
});

test('concurrent migration CAS loss is idempotent only when the migration marker became durable', async () => {
  let markerPresent=false;
  const marker={
    schemaVersion:1 as const,namespace:'__mecord_migrations',key:'migration:race',generation:1,
    valueDigest:'0'.repeat(64),value:{migrationId:'race',applied:true},updatedAt:'2026-10-07T00:00:00.000Z'
  };
  const store:ControlPlaneStore={
    async get(namespace,key){return namespace==='__mecord_migrations'&&key==='migration:race'&&markerPresent?marker:null;},
    async list(){return[];},
    async transact(){markerPresent=true;throw new OperatorError('CONTROL_PLANE_CAS_MISMATCH','concurrent migration won',{retryable:true});},
    async snapshot(){throw new Error('unused');},
    async restore(){throw new Error('unused');}
  };
  assert.equal(await applyControlPlaneMigration(store,{id:'race',mutations:[]},'2026-10-07T00:00:01.000Z'),false);

  markerPresent=false;
  const conflicting:ControlPlaneStore={
    ...store,
    async transact(){throw new OperatorError('CONTROL_PLANE_CAS_MISMATCH','unrelated conflict',{retryable:true});}
  };
  await assert.rejects(
    applyControlPlaneMigration(conflicting,{id:'race',mutations:[]},'2026-10-07T00:00:01.000Z'),
    (error:any)=>error?.code==='CONTROL_PLANE_CAS_MISMATCH'
  );
});

test('Postgres restore takes an exclusive table lock before testing the empty-store precondition', async (t) => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mecord-cp-pg-restore-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const source=new EmbeddedControlPlaneStore(dir);
  await source.transact([{namespace:'n',key:'k',expectedGeneration:null,value:{v:1}}],'2026-10-07T00:00:00.000Z');
  const snapshot=await source.snapshot('2026-10-07T00:00:01.000Z');
  const calls:string[]=[];
  const client:PostgresQueryClient={
    async query(text:string){
      calls.push(text);
      if(text==='BEGIN'||text==='COMMIT'||text==='ROLLBACK'||text.startsWith('LOCK TABLE'))return{rows:[]};
      if(text.startsWith('SELECT COUNT'))return{rows:[{count:'0'}]};
      if(text.startsWith('INSERT INTO mecord_control_plane'))return{rows:[],rowCount:1};
      throw new Error('unexpected query: '+text);
    }
  };
  await new PostgresControlPlaneStore(client).restore(snapshot);
  const lockIndex=calls.findIndex(text=>text.startsWith('LOCK TABLE mecord_control_plane IN ACCESS EXCLUSIVE MODE'));
  const countIndex=calls.findIndex(text=>text.startsWith('SELECT COUNT'));
  assert.ok(lockIndex>0&&countIndex>lockIndex);
  assert.equal(calls.at(-1),'COMMIT');
});

test('failed rollback poisons a direct Postgres transaction connection', async () => {
  let begins=0;
  const client:PostgresQueryClient={
    async query(text:string){
      if(text==='BEGIN'){begins+=1;return{rows:[]};}
      if(text==='ROLLBACK')throw new Error('connection lost during rollback');
      if(text.startsWith('SELECT pg_advisory_xact_lock'))return{rows:[]};
      if(text.startsWith('SELECT generation, expires_at'))return{rows:[{generation:9,expires_at:null}]};
      throw new Error('unexpected query: '+text);
    }
  };
  const store=new PostgresControlPlaneStore(client);
  await assert.rejects(
    store.transact([{namespace:'n',key:'k',expectedGeneration:8,value:{v:2}}],'2026-10-07T00:00:10.000Z'),
    (error:any)=>error?.code==='CONTROL_PLANE_CAS_MISMATCH'
  );
  await assert.rejects(
    store.transact([{namespace:'n',key:'other',expectedGeneration:null,value:{v:3}}],'2026-10-07T00:00:11.000Z'),
    (error:any)=>error?.code==='CONTROL_PLANE_CONNECTION_UNSAFE'
  );
  assert.equal(begins,1);
});

test('failed rollback marks a pinned pooled Postgres client unsafe on release', async () => {
  let releaseError:Error|undefined;
  const client:PostgresQueryClient={
    async query(text:string){
      if(text==='BEGIN')return{rows:[]};
      if(text==='ROLLBACK')throw new Error('rollback failed');
      if(text.startsWith('SELECT pg_advisory_xact_lock'))return{rows:[]};
      if(text.startsWith('SELECT generation, expires_at'))return{rows:[{generation:4,expires_at:null}]};
      throw new Error('unexpected query: '+text);
    },
    release(error){releaseError=error;}
  };
  const store=new PostgresControlPlaneStore({
    async query(){throw new Error('pool query must not own transaction');},
    async connect(){return client;}
  });
  await assert.rejects(
    store.transact([{namespace:'n',key:'k',expectedGeneration:3,value:{v:2}}],'2026-10-07T00:00:10.000Z'),
    (error:any)=>error?.code==='CONTROL_PLANE_CAS_MISMATCH'
  );
  assert.match(releaseError?.message??'',/rollback failed/);
});

test('independent embedded control-plane stores enforce cross-instance CAS and preserve unrelated commits', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-cp-multi-instance-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const stores = Array.from({ length: 8 }, () => new EmbeddedControlPlaneStore(dir));
  const race = await Promise.allSettled([
    stores[0]!.transact([{ namespace: 'locks', key: 'same', expectedGeneration: null, value: { owner: 'one' } }]),
    stores[1]!.transact([{ namespace: 'locks', key: 'same', expectedGeneration: null, value: { owner: 'two' } }])
  ]);
  assert.equal(race.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(race.filter((item) => item.status === 'rejected').length, 1);
  const rejected = race.find((item): item is PromiseRejectedResult => item.status === 'rejected');
  assert.equal(rejected?.reason?.code, 'CONTROL_PLANE_CAS_MISMATCH');
  assert.equal((await new EmbeddedControlPlaneStore(dir).get('locks', 'same'))?.generation, 1);

  const writes = await Promise.all(Array.from({ length: 20 }, (_, i) =>
    stores[i % stores.length]!.transact([{
      namespace: 'tasks', key: 'task-' + i, expectedGeneration: null, value: { submitted: i }
    }])
  ));
  assert.equal(writes.length, 20);
  const tasks = await stores[6]!.list('tasks');
  assert.equal(tasks.length, 20);
  assert.deepEqual(new Set(tasks.map((item) => item.value.submitted)), new Set(Array.from({ length: 20 }, (_, i) => i)));

  const snapshot = await stores[2]!.snapshot();
  const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-cp-restore-cas-'));
  t.after(() => fs.rm(empty, { recursive: true, force: true }));
  const restore = [new EmbeddedControlPlaneStore(empty), new EmbeddedControlPlaneStore(empty)];
  const restoreResult = await Promise.allSettled([restore[0]!.restore(snapshot), restore[1]!.restore(snapshot)]);
  assert.equal(restoreResult.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(restoreResult.filter((item) => item.status === 'rejected').length, 1);
  assert.equal(restoreResult.find((item): item is PromiseRejectedResult => item.status === 'rejected')?.reason?.code, 'CONTROL_PLANE_RESTORE_CONFLICT');
  assert.equal((await restore[0]!.list('tasks')).length, 20);
});

test('embedded control-plane CAS never recycles deleted keys or allows old owners to overwrite reincarnated records', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-cp-aba-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const firstStore = new EmbeddedControlPlaneStore(dir);
  const [first] = await firstStore.transact([
    { namespace: 'authority', key: 'session:one', expectedGeneration: null, value: { owner: 'first' } }
  ], '2026-10-07T00:00:00.000Z');
  assert.equal(first?.generation, 1);
  const oldSnapshot = await firstStore.snapshot('2026-10-07T00:00:01.000Z');
  await firstStore.transact([
    { namespace: 'authority', key: 'session:one', expectedGeneration: first!.generation, value: null }
  ], '2026-10-07T00:00:02.000Z');
  assert.equal(await firstStore.get('authority', 'session:one'), null);
  await assert.rejects(
    () => firstStore.restore(oldSnapshot),
    (error: any) => error?.code === 'CONTROL_PLANE_RESTORE_CONFLICT'
  );

  const independent = new EmbeddedControlPlaneStore(dir);
  const [second] = await independent.transact([
    { namespace: 'authority', key: 'session:one', expectedGeneration: null, value: { owner: 'second' } }
  ], '2026-10-07T00:00:03.000Z');
  assert.equal(second?.generation, 2);
  await assert.rejects(
    () => firstStore.transact([
      { namespace: 'authority', key: 'session:one', expectedGeneration: first!.generation, value: { owner: 'stale' } }
    ], '2026-10-07T00:00:04.000Z'),
    (error: any) => error?.code === 'CONTROL_PLANE_CAS_MISMATCH'
  );
  assert.equal((await new EmbeddedControlPlaneStore(dir).get('authority', 'session:one'))?.value.owner, 'second');

  const [expiring] = await firstStore.transact([
    { namespace: 'authority', key: 'lease:expired', expectedGeneration: null, value: { owner: 'old' }, expiresAt: '2026-10-07T00:00:06.000Z' }
  ], '2026-10-07T00:00:05.000Z');
  assert.equal(await purgeExpiredControlPlaneRecords(independent, 'authority', '2026-10-07T00:00:07.000Z'), 1);
  const [renewed] = await independent.transact([
    { namespace: 'authority', key: 'lease:expired', expectedGeneration: null, value: { owner: 'new' } }
  ], '2026-10-07T00:00:08.000Z');
  assert.ok(renewed!.generation > expiring!.generation);
  await assert.rejects(
    () => firstStore.transact([
      { namespace: 'authority', key: 'lease:expired', expectedGeneration: expiring!.generation, value: { owner: 'stale' } }
    ], '2026-10-07T00:00:09.000Z'),
    (error: any) => error?.code === 'CONTROL_PLANE_CAS_MISMATCH'
  );
});

test('PostgreSQL control-plane retains deleted CAS history as invisible durable tombstones', async () => {
  let row: { generation: number; expires_at: string | null; is_deleted: boolean } | undefined;
  const client: PostgresQueryClient = {
    async query(sql: string, values?: unknown[]) {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [] };
      if (sql.startsWith('SELECT generation, expires_at')) return { rows: row ? [{ ...row }] : [] };
      if (sql.startsWith('UPDATE mecord_control_plane SET is_deleted=TRUE')) {
        assert.ok(row);
        row!.is_deleted = true;
        row!.expires_at = null;
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('INSERT INTO mecord_control_plane')) {
        row = { generation: Number(values?.[2]), expires_at: (values?.[6] as string | null) ?? null, is_deleted: false };
        return { rows: [], rowCount: 1 };
      }
      throw new Error('Unexpected SQL in PostgreSQL ABA test: ' + sql);
    }
  };
  const store = new PostgresControlPlaneStore(client);
  const [first] = await store.transact([
    { namespace: 'authority', key: 'one', expectedGeneration: null, value: { owner: 'first' } }
  ], '2026-10-07T00:00:00.000Z');
  assert.equal(first?.generation, 1);
  await store.transact([
    { namespace: 'authority', key: 'one', expectedGeneration: first!.generation, value: null }
  ], '2026-10-07T00:00:01.000Z');
  assert.equal(row?.is_deleted, true);
  assert.equal(row?.generation, 1);
  const [recreated] = await store.transact([
    { namespace: 'authority', key: 'one', expectedGeneration: null, value: { owner: 'second' } }
  ], '2026-10-07T00:00:02.000Z');
  assert.equal(recreated?.generation, 2);
  await assert.rejects(
    () => store.transact([
      { namespace: 'authority', key: 'one', expectedGeneration: first!.generation, value: { owner: 'stale' } }
    ], '2026-10-07T00:00:03.000Z'),
    (error: any) => error?.code === 'CONTROL_PLANE_CAS_MISMATCH'
  );
  assert.equal(row?.generation, 2);
  assert.equal(row?.is_deleted, false);
});

test('explicit invalid expiry never becomes indefinite authority in mutations or restored records', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-cp-expiry-presence-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new EmbeddedControlPlaneStore(dir);

  for (const malformed of ['', null]) {
    await assert.rejects(
      () => store.transact([{
        namespace: 'leases', key: 'bounded', expectedGeneration: null,
        value: { scope: 'session' }, expiresAt: malformed as string
      }], '2026-10-09T00:00:00.000Z'),
      (error: any) => error?.code === 'CONTROL_PLANE_STORE_INVALID'
    );
  }
  assert.equal(await store.get('leases', 'bounded'), null);

  const [live] = await store.transact([{
    namespace: 'leases', key: 'bounded', expectedGeneration: null,
    value: { scope: 'session' }, expiresAt: '2026-10-09T00:01:00.000Z'
  }], '2026-10-09T00:00:00.000Z');
  assert.equal(live?.expiresAt, '2026-10-09T00:01:00.000Z');

  const stateFile = path.join(dir, 'control-plane-store.json');
  const original = await fs.readFile(stateFile, 'utf8');
  const poisoned = JSON.parse(original);
  poisoned.records[0].expiresAt = '';
  await fs.writeFile(stateFile, JSON.stringify(poisoned), 'utf8');
  await assert.rejects(
    () => new EmbeddedControlPlaneStore(dir).get('leases', 'bounded'),
    (error: any) => error?.code === 'CONTROL_PLANE_STORE_INVALID'
  );
  await fs.writeFile(stateFile, original, 'utf8');
  assert.equal((await new EmbeddedControlPlaneStore(dir).get('leases', 'bounded'))?.expiresAt, live!.expiresAt);
});

test('independent PostgreSQL store wrappers serialize direct-client transactions and reads', async () => {
  let beginCount = 0;
  let opened = false;
  let unblock!: () => void;
  let reached!: () => void;
  const entered = new Promise<void>(resolve => { reached = resolve; });
  const gate = new Promise<void>(resolve => { unblock = resolve; });
  const calls: string[] = [];
  const db: PostgresQueryClient = {
    async query(sql: string) {
      calls.push(sql);
      if (sql === 'BEGIN') {
        assert.equal(opened, false, 'shared direct client cannot start nested transactions');
        opened = true;
        beginCount++;
        return { rows: [] };
      }
      if (sql === 'COMMIT' || sql === 'ROLLBACK') {
        assert.equal(opened, true);
        opened = false;
        return { rows: [] };
      }
      if (sql.startsWith('SELECT pg_advisory_xact_lock')) {
        if (beginCount === 1) { reached(); await gate; }
        return { rows: [] };
      }
      if (sql.startsWith('SELECT generation, expires_at')) return { rows: [] };
      if (sql.startsWith('INSERT INTO mecord_control_plane')) return { rows: [], rowCount: 1 };
      if (sql.startsWith('SELECT namespace, record_key')) {
        assert.equal(opened, false, 'direct-client reader must not see uncommitted state');
        return { rows: [] };
      }
      throw new Error('unexpected SQL in direct-client serialization test: ' + sql);
    }
  };
  const first = new PostgresControlPlaneStore(db);
  const second = new PostgresControlPlaneStore(db);
  const tx1 = first.transact([{ namespace: 'n', key: 'a', expectedGeneration: null, value: { v: 1 } }]);
  await entered;
  const read = second.get('n', 'a');
  const tx2 = second.transact([{ namespace: 'n', key: 'b', expectedGeneration: null, value: { v: 2 } }]);
  // An overlapping call would issue a second BEGIN before the first COMMIT.
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(beginCount, 1);
  assert.equal(calls.filter(sql => sql.startsWith('SELECT namespace, record_key')).length, 0);
  unblock();
  await Promise.all([tx1, read, tx2]);
  assert.equal(beginCount, 2);
  const firstCommit = calls.indexOf('COMMIT');
  const readAt = calls.findIndex(sql => sql.startsWith('SELECT namespace, record_key'));
  const secondBegin = calls.indexOf('BEGIN', calls.indexOf('BEGIN') + 1);
  assert.ok(firstCommit >= 0 && readAt > firstCommit && secondBegin > readAt);
});

test('direct PostgreSQL rollback poisoning applies across independent store wrappers', async () => {
  let beginCount = 0;
  const db: PostgresQueryClient = {
    async query(sql: string) {
      if (sql === 'BEGIN') { beginCount++; return { rows: [] }; }
      if (sql === 'ROLLBACK') throw new Error('rollback transport lost');
      if (sql.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [] };
      if (sql.startsWith('SELECT generation, expires_at')) return { rows: [{ generation: 9, expires_at: null }] };
      throw new Error('unexpected SQL in direct-client poisoning test: ' + sql);
    }
  };
  const first = new PostgresControlPlaneStore(db);
  const second = new PostgresControlPlaneStore(db);
  await assert.rejects(
    first.transact([{ namespace: 'n', key: 'x', expectedGeneration: 8, value: { v: 1 } }]),
    (error: any) => error?.code === 'CONTROL_PLANE_CAS_MISMATCH'
  );
  await assert.rejects(
    second.get('n', 'x'),
    (error: any) => error?.code === 'CONTROL_PLANE_CONNECTION_UNSAFE'
  );
  await assert.rejects(
    second.transact([{ namespace: 'n', key: 'y', expectedGeneration: null, value: { v: 2 } }]),
    (error: any) => error?.code === 'CONTROL_PLANE_CONNECTION_UNSAFE'
  );
  assert.equal(beginCount, 1);
});
