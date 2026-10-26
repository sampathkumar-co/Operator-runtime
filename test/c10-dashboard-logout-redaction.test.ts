import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';

const privateIds = [
  'taskList','approvalList','recoveryList','onboardingList','activityList',
  'deviceList','policyList','knowledgeList','diagnosticList','teamList',
  'studioList','desiredList','taskDetail'
];

async function createUi() {
  const source = await fs.readFile(path.resolve('apps/control-center/src/app.js'),'utf8');
  const start = source.indexOf('let connected=false,selected=');
  const end = source.indexOf('function node(',start);
  assert.ok(start>=0&&end>start,'maintained session and API functions must exist');
  const elements = new Map([...privateIds,'selectedState'].map(id =>
    [id,{textContent:'PRIVATE_PERSONAL_DATA',children:['private'],replaceChildren() { this.children=[];this.textContent=''; }}]));
  const queue = [];
  const context = {
    document: { getElementById(id) { return elements.get(id)??null; } },
    fetch: () => new Promise(resolve => { queue.push(resolve); })
  };
  const ui = vm.runInNewContext(source.slice(start,end)+
    ';connected=true;({api,clearPrivatePanels,getEpoch:()=>authEpoch})',context);
  return { ui, queue, elements };
}

test('C10 logout scrubs every private panel and discards already-running HTTP reads',async()=>{
  const {ui,queue,elements}=await createUi();
  const request=ui.api('/v1/tasks');
  assert.equal(queue.length,1);
  ui.clearPrivatePanels();
  queue[0]({ok:true,status:200,json:async()=>({tasks:[{id:'private'}]})});
  await assert.rejects(request,/session changed/);
  for(const id of privateIds){
    assert.deepEqual([...elements.get(id).children],[]);
    assert.equal(elements.get(id).textContent,'Sign in to view this information.');
  }
  assert.equal(elements.get('selectedState').textContent,'—');
  await assert.rejects(ui.api('/v1/tasks'),/Sign in/);
});
test('C10 active HTTP 401 invalidates epoch and all dashboard panels',async()=>{
  const {ui,queue,elements}=await createUi();
  const request=ui.api('/v1/recovery');
  queue[0]({ok:false,status:401,json:async()=>({error:{code:'UNAUTHORIZED'}})});
  await assert.rejects(request,/session changed/);
  assert.ok(ui.getEpoch()>0);
  assert.equal(elements.get('recoveryList').textContent,'Sign in to view this information.');
});
test('C10 bootstrap and unload cannot silently restore browser authority',async()=>{
  const source=await fs.readFile(path.resolve('apps/control-center/src/app.js'),'utf8');
  assert.match(source,/startupEpoch===authEpoch/);
  assert.match(source,/beforeunload.*clearPrivatePanels/);
  assert.doesNotMatch(source,/localStorage|sessionStorage/);
});
