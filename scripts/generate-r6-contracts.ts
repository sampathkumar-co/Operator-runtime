import fs from 'node:fs/promises';
import path from 'node:path';
import { R6_CONTRACT_SCHEMAS } from '../src/core/r6-contract-schemas.ts';

const root=path.join(process.cwd(),'schemas','r6');
await fs.mkdir(root,{recursive:true});
for(const [name,schema] of Object.entries(R6_CONTRACT_SCHEMAS)){
  await fs.writeFile(path.join(root,name+'.schema.json'),JSON.stringify(schema,null,2)+'\n','utf8');
}
process.stdout.write(JSON.stringify({ok:true,count:Object.keys(R6_CONTRACT_SCHEMAS).length})+'\n');
