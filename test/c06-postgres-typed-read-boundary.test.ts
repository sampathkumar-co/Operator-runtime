import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PostgresProvider } from '../src/capabilities/postgres.ts';

async function setup(t: test.TestContext) {
  const base=await fs.mkdtemp(path.join(os.tmpdir(),'mecord-c06-postgres-'));
  t.after(async()=>{await fs.rm(base,{recursive:true,force:true});});
  const project=path.join(base,'project');
  await fs.mkdir(project);
  const registryPath=path.join(base,'pg-profiles.json');
  const validProfile={
    id:'local',roots:[project],host:'127.0.0.1',port:5432,
    database:'testdb',user:'testuser',sslMode:'disable'
  };
  const save=async profile=>fs.writeFile(registryPath,JSON.stringify({version:1,profiles:[profile]}));
  await save(validProfile);
  const provider=new PostgresProvider({allowedRoots:[project],registryPath,
    psqlExecutable:'/missing/psql/must/not/run'});
  return {project,registryPath,validProfile,save,provider};
}

test('C06 PostgreSQL refuses type-confused project identity and query scope before SQL',async t=>{
  const h=await setup(t);
  let conversions=0;
  const hostile={toString(){conversions++;return h.project;}};
  const base={path:h.project,profileId:'local',table:'items'};
  const bad=[
    {input:{...base,path:[h.project]},code:'POSTGRES_PROJECT_SCOPE_INVALID'},
    {input:{...base,path:hostile},code:'POSTGRES_PROJECT_SCOPE_INVALID'},
    {input:{...base,profileId:['local']},code:'POSTGRES_PROFILE_ID_REQUIRED'},
    {input:{...base,schema:['public']},code:'POSTGRES_IDENTIFIER_INVALID'},
    {input:{...base,table:['items']},code:'POSTGRES_IDENTIFIER_INVALID'},
    {input:{...base,columns:[['id']]},code:'POSTGRES_IDENTIFIER_INVALID'},
    {input:{...base,filters:[{column:['id'],op:'eq',value:1}]},code:'POSTGRES_IDENTIFIER_INVALID'},
    {input:{...base,filters:[{column:'id',op:['eq'],value:1}]},code:'POSTGRES_FILTERS_INVALID'},
    {input:{...base,filters:[{column:'id',op:'eq',value:hostile}]},code:'POSTGRES_PARAMETER_INVALID'},
    {input:{...base,filters:[{column:'id',op:'eq'}]},code:'POSTGRES_PARAMETER_INVALID'},
    {input:{...base,orderBy:[{column:['id'],direction:'asc'}]},code:'POSTGRES_IDENTIFIER_INVALID'},
    {input:{...base,orderBy:[{column:'id',direction:['asc']}]},code:'POSTGRES_ORDER_INVALID'},
    {input:{...base,limit:'10'},code:'POSTGRES_BUDGET_INVALID'},
    {input:{...base,offset:[0]},code:'POSTGRES_BUDGET_INVALID'},
    {input:{...base,maxBytes:'1024'},code:'POSTGRES_BUDGET_INVALID'},
    {input:{...base,timeoutMs:true},code:'POSTGRES_BUDGET_INVALID'},
    {input:{...base,limit:1.5},code:'POSTGRES_BUDGET_INVALID'}
  ];
  for(const [index,entry] of bad.entries()){
    const out=await h.provider.execute({
      id:'bad-pg-'+index,capability:'postgres.select',risk:'read',
      input:entry.input,provenance:{kind:'runtime'}
    } as any);
    assert.equal(out.ok,false,JSON.stringify(entry.input));
    assert.equal(out.error?.code,entry.code,JSON.stringify(entry.input));
  }
  assert.equal(conversions,0);
});

test('C06 stored PostgreSQL registry never accepts coerced host/account/SSL/port/root authority',async t=>{
  const h=await setup(t);
  for(const extra of [
    {id:['local']},{roots:[[h.project]]},{host:['127.0.0.1']},
    {port:'5432'},{database:['testdb']},{user:['testuser']},
    {passwordEnv:['EXAMPLE_PASSWORD']},{sslMode:['disable']}
  ]){
    await h.save({...h.validProfile,...extra});
    const result=await h.provider.execute({
      id:'bad-authority',capability:'postgres.inspect',risk:'read',
      input:{path:h.project,operation:'profiles'},provenance:{kind:'runtime'}
    });
    assert.equal(result.ok,false,JSON.stringify(Object.keys(extra)));
    assert.equal(result.error?.code,'POSTGRES_REGISTRY_INVALID');
  }
});

test('C06 oversized first PostgreSQL row must fail rather than return nonprogressing nextOffset',async t=>{
  const h=await setup(t);
  const script=path.join(path.dirname(h.registryPath),'fake-psql.cjs');
  await fs.writeFile(script,"process.stdout.write('id,note\\n1,'+'x'.repeat(4000)+'\\n');");
  const provider=new PostgresProvider({
    allowedRoots:[h.project],registryPath:h.registryPath,
    psqlExecutable:process.execPath,psqlArgsPrefix:[script]
  });
  const result=await provider.execute({
    id:'single-huge-row',capability:'postgres.select',risk:'read',
    input:{path:h.project,profileId:'local',table:'items',maxBytes:1024,limit:1},
    provenance:{kind:'runtime'}
  });
  assert.equal(result.ok,false);
  assert.equal(result.error?.code,'POSTGRES_ROW_TOO_LARGE');
});
