import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';

function element() {
  return {
    id: '', className: '', textContent: '', children: [] as any[],
    setAttribute(_key: string,_value: string) {},
    append(...children: any[]) { this.children.push(...children); },
    replaceChildren(...children: any[]) { this.children=children; this.textContent=''; },
    insertBefore(child: any) { this.children.push(child); }
  };
}
function harness(script: string) {
  const diagnostics = element();
  const list = element();
  const queue: Array<(result: any)=>void> = [];
  let interval!: ()=>void;
  let unload!: ()=>void;
  const context = {
    document: {
      getElementById(id: string) {
        return id==='diagnostics' ? diagnostics : id==='diagnosticList' ? list : null;
      },
      createElement: () => element()
    },
    fetch: () => new Promise(resolve => { queue.push(resolve); }),
    setInterval: (cb: ()=>void) => { interval=cb; return 1; },
    clearInterval: () => {},
    window: { addEventListener(_name: string,cb: ()=>void) { unload=cb; } }
  };
  vm.runInNewContext(script,context);
  const body=()=>diagnostics.children[0].children[1];
  return { queue, tick:()=>interval(), unload:()=>unload(), body };
}
const status = {
  product: {
    runtimeVersion:'2.0.6',packageVersion:'2.0.6',
    compatibility:'MATCH',sourceIdentity:'KNOWN',sourceCommit:'a'.repeat(40)
  },
  uptimeMs:7000,relay:{state:'READY',freshness:'FRESH'},
  capabilities:{count:0,names:[]},
  configuration:{optionalFeatures:[],authorizedRootCount:0}
};
async function settle() { await new Promise(resolve=>setImmediate(resolve)); }

test('C10 older successful runtime-status response cannot repaint after newer 401 logout', async () => {
  const script=await fs.readFile(path.resolve('apps/control-center/src/runtime-status.js'),'utf8');
  const ui=harness(script);
  assert.equal(ui.queue.length,1);
  ui.tick();
  assert.equal(ui.queue.length,2);
  ui.queue[1]!({status:401,ok:false,json:async()=>({})});
  await settle();
  assert.equal(ui.body().textContent,'Sign in to load source and capability status.');
  ui.queue[0]!({status:200,ok:true,json:async()=>({status})});
  await settle();
  assert.equal(ui.body().textContent,'Sign in to load source and capability status.');
  assert.equal(ui.body().children.length,0);
  ui.unload();
});

test('C10 failed newer status refresh removes previously successful metrics', async () => {
  const script=await fs.readFile(path.resolve('apps/control-center/src/runtime-status.js'),'utf8');
  const ui=harness(script);
  ui.queue[0]!({status:200,ok:true,json:async()=>({status})});
  await settle();
  assert.ok(ui.body().children.length>0,'status metrics should have rendered');
  ui.tick();
  ui.queue[1]!({status:503,ok:false,json:async()=>({error:'offline'})});
  await settle();
  assert.equal(ui.body().children.length,0,'old metrics must be removed on error');
  assert.match(ui.body().textContent,/temporarily unavailable/);
  ui.unload();
});
