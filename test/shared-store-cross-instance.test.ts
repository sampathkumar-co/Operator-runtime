import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { WorldModelStore } from '../src/core/world-model.ts';
import { ProcedureMemoryStore } from '../src/core/procedure-memory.ts';
import { ExecutionOptimizerStore } from '../src/core/execution-optimizer.ts';

const exec = promisify(execFile);
async function tempDir(t: test.TestContext): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-shared-stores-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
test('independent world-model instances preserve all source claims', async t => {
  const dir = await tempDir(t);
  await Promise.all(Array.from({length: 8}, (_, i) => new WorldModelStore(dir).observe({
    entity: { key:'service:shared', type:'service', scopeKey:'project:a', label:'Shared' },
    source: 'source:' + i, domain:'application', evidenceDigest: i.toString(16).repeat(64),
    facts: {status:'healthy'}, confidence:0.85
  })));
  const fact = await new WorldModelStore(dir).resolveFact('service:shared','status');
  assert.equal(fact.status,'resolved');
  assert.equal(fact.claims.length,8);
  const raw = JSON.parse(await fs.readFile(path.join(dir,'world-model.json'),'utf8'));
  assert.equal(raw.history.length,8);
});
test('independent verified-procedure stores retain every distinct procedure', async t => {
  const dir = await tempDir(t);
  await Promise.all(Array.from({length: 8}, (_, i) => new ProcedureMemoryStore(dir).recordVerified({
    key:'safe-'+i,title:'Safe',objectiveKind:'build',scopeKey:'project:a',
    steps:[{capability:'project.command.run',risk:'read',summary:'Run check'}],
    assumptions:[],verificationDigest:i.toString(16).repeat(64),
    verifierEvidenceDigest:'f'.repeat(64)
  })));
  const all = await new ProcedureMemoryStore(dir).list(100);
  assert.equal(all.length,8);
  assert.equal(new Set(all.map(x=>x.key)).size,8);
});
test('independent optimizer writers do not lose receipts or double count shared receipt', async t => {
  const dir = await tempDir(t);
  const stores = Array.from({length:8},()=>new ExecutionOptimizerStore(dir));
  await Promise.all(stores.map((s,i)=>s.record('build','safe',{verified:true,durationMs:1},(i+1).toString(16).padStart(64,'0'))));
  await Promise.all(stores.map(s=>s.record('build','safe',{verified:true,durationMs:1},'a'.repeat(64))));
  const entry=(await new ExecutionOptimizerStore(dir).inspect()).find(x=>x.context==='build');
  assert.equal(entry?.verified,9);
  assert.equal(entry?.samples,9);
});
test('independent OS processes cannot lose optimizer outcomes', async t => {
  const dir=await tempDir(t);
  const url=pathToFileURL(path.resolve('src/core/execution-optimizer.ts')).href;
  const script=`import {ExecutionOptimizerStore} from ${JSON.stringify(url)};
const s=new ExecutionOptimizerStore(process.argv[1]);
await s.record('multi','safe',{verified:true,durationMs:2},process.argv[2].padStart(64,'0'));`;
  await Promise.all(Array.from({length:4},(_,i)=>exec(process.execPath,
    ['--experimental-strip-types','--input-type=module','-e',script,dir,String(i+1)],
    {cwd:process.cwd(),timeout:30000,windowsHide:true})));
  const entry=(await new ExecutionOptimizerStore(dir).inspect()).find(x=>x.context==='multi');
  assert.equal(entry?.verified,4);
});

test('independent perception graph writers preserve separately observed targets', async t => {
  const dir=await tempDir(t);
  const {PerceptionGraphStore,perceptionDigest}=await import('../src/core/perception-graph.ts');
  await Promise.all(Array.from({length:8},(_,i)=>new PerceptionGraphStore(dir).observe({
    sceneKey:'browser:shared',channel:'dom',source:'browser',
    semanticId:'target-'+i,role:'button',name:'Button '+i,
    state:{enabled:true},confidence:0.95,
    evidenceDigest:perceptionDigest('target-'+i)
  })));
  const nodes=await new PerceptionGraphStore(dir).scene('browser:shared');
  assert.equal(nodes.length,8);
});
