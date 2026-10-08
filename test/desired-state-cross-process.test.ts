import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { DesiredStateController } from '../src/core/desired-state.ts';
import { worldValueDigest } from '../src/core/world-model.ts';

const exec=promisify(execFile);

test('genuinely independent processes dispatch exactly one journalled remediation',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'operator-desired-process-'));
 t.after(()=>fs.rm(dir,{force:true,recursive:true}));
 const world={resolveFact:async()=>({status:'resolved',value:'broken',claims:[]})};
 const operations={submit:async()=>{throw new Error('creation must not dispatch')}};
 const controller=new DesiredStateController(dir,{world:world as any,operations:operations as any});
 const contract=await controller.create({
   contractId:crypto.randomUUID(),name:'Keep the service available',
   scopeKey:'project:service',desired:[{
     entityKey:'service:a',factKey:'health',expectedValueDigest:worldValueDigest('healthy')
   }],
   remediation:{objective:'Restore service',successConditions:['healthy'],
     authority:{maxRisk:'write',capabilities:['file.write'],resources:['repo:/service']}
   },
   policy:{autoRemediate:true,minRemediationIntervalMs:0,maxRemediationsPerDay:12,maxConsecutiveFailures:3}
 });
 const log=path.join(dir,'submissions.jsonl');
 const uri=pathToFileURL(path.resolve('src/core/desired-state.ts')).href;
 const script=`import fs from 'node:fs/promises';
import {DesiredStateController} from ${JSON.stringify(uri)};
const state=process.argv[1],log=process.argv[2],id=process.argv[3];
const world={resolveFact:async()=>({status:'resolved',value:'broken',claims:[]})};
const ops={
  submit:async input=>{await fs.appendFile(log,JSON.stringify({id:input.requestId})+'\\n');await new Promise(r=>setTimeout(r,75));return {id:input.requestId,state:'RUNNING'};},
  refresh:async id=>({id,state:'RUNNING'})
};
await new DesiredStateController(state,{world,operations:ops}).reconcile(id);`;
 await Promise.all(Array.from({length:2},()=>exec(process.execPath,[
   '--experimental-strip-types','--input-type=module','-e',script,dir,log,contract.id
 ],{cwd:process.cwd(),windowsHide:true,timeout:30000})));
 const submitted=(await fs.readFile(log,'utf8')).trim().split('\n');
 assert.equal(submitted.length,1);
 const persisted=JSON.parse(await fs.readFile(path.join(dir,'desired-state.json'),'utf8'));
 assert.equal(persisted.contracts[0].remediationHistory.length,1);
 assert.equal(persisted.contracts[0].activeOperationId,JSON.parse(submitted[0]!).id);
});
