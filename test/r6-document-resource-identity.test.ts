import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  resourceKeysForAction,
  resolvePhysicalResourceKeysForAction,
  resourceKeysConflict
} from '../src/core/resource-identity.ts';

function action(capability:string,file:string){
  return {
    id:'r6-resource-'+capability.replaceAll('.','-'),
    capability,
    risk:'read' as const,
    input:{path:file},
    provenance:{kind:'runtime' as const}
  };
}

test('document and structured adapters share canonical file identity with filesystem access',async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'r6-document-resource-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const file=path.join(root,'sample.pdf');
  await fs.writeFile(file,'%PDF-1.7\n%%EOF\n');

  const fileKeys=resourceKeysForAction(action('file.read',file));
  const documentKeys=resourceKeysForAction(action('document.extract',file));
  const structuredKeys=resourceKeysForAction(action('structured.inspect',file));
  assert.deepEqual(documentKeys,fileKeys);
  assert.deepEqual(structuredKeys,fileKeys);

  const physicalFile=await resolvePhysicalResourceKeysForAction(action('file.read',file));
  const physicalDocument=await resolvePhysicalResourceKeysForAction(action('document.extract',file));
  assert.deepEqual(physicalDocument,physicalFile);
  for(const key of physicalDocument) assert.equal(resourceKeysConflict(key,key),true);
});
