import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FilesystemProvider } from '../src/capabilities/filesystem.ts';

test('C06 filesystem read/search does not broaden malformed requested scope',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mecord-c06-fs-bound-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const target=path.join(root,'report.txt');
  await fs.writeFile(target,'verified content');
  const provider=new FilesystemProvider({allowedRoots:[root]});
  let coercions=0;
  const hostile={toString(){coercions++;return 'file';},valueOf(){coercions++;return 0;}};
  const cases=[
    {capability:'file.read',input:{path:target,encoding:['base64']}},
    {capability:'file.read',input:{path:target,encoding:'unexpected'}},
    {capability:'file.read',input:{path:target,offset:'0'}},
    {capability:'file.read',input:{path:target,maxBytes:hostile}},
    {capability:'file.read',input:{path:target,maxBytes:NaN}},
    {capability:'file.list',input:{path:root,offset:[0]}},
    {capability:'file.list',input:{path:root,limit:'500'}},
    {capability:'file.search',input:{path:root,query:'report',kind:['file']}},
    {capability:'file.search',input:{path:root,query:'report',kind:'unknown'}},
    {capability:'file.search',input:{path:root,query:'report',kind:hostile}},
    {capability:'file.search',input:{path:root,query:'report',maxDepth:'8'}},
    {capability:'file.search',input:{path:root,query:'report',maxResults:[1]}}
  ];
  for(const [i,entry] of cases.entries()){
    const res=await provider.execute({id:'invalid-fs-'+i,capability:entry.capability,
      risk:'read',input:entry.input,provenance:{kind:'runtime'}} as any);
    assert.equal(res.ok,false,entry.capability+' '+i);
    assert.equal(res.error?.code,'FILESYSTEM_INPUT_INVALID',entry.capability+' '+i);
  }
  assert.equal(coercions,0);
  for(const good of [
    {capability:'file.read',input:{path:target,encoding:'utf8',offset:0,maxBytes:1024}},
    {capability:'file.search',input:{path:root,query:'report',kind:'file',maxDepth:0,maxResults:1}},
    {capability:'file.list',input:{path:root,limit:1,offset:0}}
  ]){
    const res=await provider.execute({...good,id:'valid-fs',risk:'read',
      provenance:{kind:'runtime'}} as any);
    assert.equal(res.ok,true,res.error?.message);
  }
});
