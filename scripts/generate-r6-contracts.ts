import fs from 'node:fs/promises';
import path from 'node:path';
import {
  R6_AGENT_GATEWAY_SCHEMA,
  R6_CAPABILITY_MANIFEST_SCHEMA,
  R6_GATEWAY_EVENT_SCHEMA,
  R6_OPENAPI
} from '../src/core/r6-contracts.ts';

const root=process.cwd();
const files:Record<string,unknown>={
  'contracts/r6/agent-gateway-proposal-v1.schema.json':R6_AGENT_GATEWAY_SCHEMA,
  'contracts/r6/capability-manifest-v1.schema.json':R6_CAPABILITY_MANIFEST_SCHEMA,
  'contracts/r6/gateway-event-v1.schema.json':R6_GATEWAY_EVENT_SCHEMA,
  'contracts/r6/openapi.json':R6_OPENAPI
};
const check=process.argv.includes('--check');
let drift=false;
for(const [relative,value] of Object.entries(files)){
  const target=path.join(root,relative);
  const content=JSON.stringify(value,null,2)+'\n';
  if(check){
    let current='';try{current=await fs.readFile(target,'utf8');}catch{}
    if(current!==content){process.stderr.write('R6 contract drift: '+relative+'\n');drift=true;}
  }else{
    await fs.mkdir(path.dirname(target),{recursive:true});
    await fs.writeFile(target,content,'utf8');
  }
}
if(drift)process.exitCode=1;
else process.stdout.write(JSON.stringify({ok:true,check,files:Object.keys(files).length})+'\n');
