import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EmbeddedControlPlaneStore } from '../src/core/control-plane-store.ts';

test('control-plane CAS never coerces expectedGeneration into valid authority', async t => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'operator-cas-exact-generation-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const store=new EmbeddedControlPlaneStore(dir);
  const [created]=await store.transact([{
    namespace:'authority',key:'device',expectedGeneration:null,value:{owner:'initial'}
  }]);
  assert.equal(created.generation,1);
  for(const invalid of ['1',true,[1],null]) {
    if(invalid === null) continue; // null is explicitly create-if-absent CAS.
    await assert.rejects(store.transact([{
      namespace:'authority',key:'device',expectedGeneration:invalid,value:{owner:'forged'}
    }] as any), (e:any)=>e?.code==='CONTROL_PLANE_STORE_INVALID');
    assert.deepEqual((await store.get('authority','device'))?.value,{owner:'initial'});
  }
});

test('embedded generation and tombstone history reject nonnumeric representations on restart',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'operator-cas-generation-corruption-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'control-plane-store.json');
  const store=new EmbeddedControlPlaneStore(dir);
  const [created]=await store.transact([{namespace:'authority',key:'deleted',expectedGeneration:null,value:{owner:'old'}}]);
  const snapshot=JSON.parse(await fs.readFile(file,'utf8'));
  await store.transact([{namespace:'authority',key:'deleted',expectedGeneration:created.generation,value:null}]);
  const tombstoned=JSON.parse(await fs.readFile(file,'utf8'));
  for(const invalid of ['1',true,[1],null]){
    const damaged=structuredClone(snapshot);
    damaged.records[0].generation=invalid;
    await fs.writeFile(file,JSON.stringify(damaged));
    await assert.rejects(()=>new EmbeddedControlPlaneStore(dir).get('authority','deleted'),
      (e:any)=>e?.code==='CONTROL_PLANE_STORE_INVALID');
    const cut=structuredClone(tombstoned);
    cut.tombstones[0].generation=invalid;
    await fs.writeFile(file,JSON.stringify(cut));
    await assert.rejects(()=>new EmbeddedControlPlaneStore(dir).snapshot(),
      (e:any)=>e?.code==='CONTROL_PLANE_STORE_INVALID');
  }
  await fs.writeFile(file,JSON.stringify(tombstoned));
  const [recreated]=await new EmbeddedControlPlaneStore(dir).transact([{
    namespace:'authority',key:'deleted',expectedGeneration:null,value:{owner:'new'}
  }]);
  assert.equal(recreated.generation,2);
  await assert.rejects(()=>new EmbeddedControlPlaneStore(dir).transact([{
    namespace:'authority',key:'deleted',expectedGeneration:1,value:{owner:'stale'}
  }]),(e:any)=>e?.code==='CONTROL_PLANE_CAS_MISMATCH');
});
