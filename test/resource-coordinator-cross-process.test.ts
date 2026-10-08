import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { ResourceLeaseStore } from '../src/core/resource-leases.ts';

const exec = promisify(execFile);

test('concurrent separate processes never steal resource coordinator ownership', async t => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'operator-coordinator-process-'));
  t.after(()=>fs.rm(dir,{force:true,recursive:true}));
  const url=pathToFileURL(path.resolve('src/core/resource-leases.ts')).href;
  const script=`import { ResourceLeaseStore } from ${JSON.stringify(url)};
const lease = await new ResourceLeaseStore(process.argv[1]).acquire(
  'owner:'+process.argv[2], ['coordination-key:'+process.argv[2]], 'exclusive');
await lease.assertOwned();
await lease.release();`;
  for (let round=0;round<3;round+=1){
    const results=await Promise.allSettled(Array.from({length:4},(_,i)=>exec(
      process.execPath,['--experimental-strip-types','--input-type=module','-e',script,dir,`${round}-${i}`],
      {cwd:process.cwd(),windowsHide:true,timeout:30000}
    )));
    const failures=results.filter(x=>x.status==='rejected');
    assert.equal(failures.length,0,JSON.stringify(failures.map(x=>String((x as PromiseRejectedResult).reason)),null,2));
    const state=await new ResourceLeaseStore(dir).inspect();
    assert.equal(state.resources.length,0);
  }
});
