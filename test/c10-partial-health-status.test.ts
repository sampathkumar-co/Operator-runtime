import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { renderControlCenter } from '../apps/local-agent/src/control-center.ts';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../apps/control-center/src');
const loaders = ['loadTasks','loadApprovals','loadRecovery','loadOnboarding','loadActivity',
  'loadDevices','loadPolicies','loadKnowledge','loadDiagnostics','loadTeams','loadStudioRuns','loadDesired'];

async function simulate(options: { failed?: string[]; expired?: boolean; allDown?: boolean } = {}) {
  const script = await fs.readFile(path.join(source,'app.js'),'utf8');
  const start=script.indexOf('async function refresh(){');
  const end=script.indexOf('async function submit(',start);
  assert.ok(start>=0 && end>start,'expected maintained UI refresh implementation');
  const text=script.slice(start,end);
  const state = {
    statusDot:{className:''},
    statusText:{textContent:''}
  };
  const messages: string[] = [];
  const env: Record<string,unknown> = {
    connected:true, selected:'', selectedKind:'task',
    $:(id:string)=>(state as any)[id],
    toast:(value:string)=>messages.push(value)
  };
  for (const name of loaders) {
    env[name] = async () => {
      if (name==='loadApprovals' && options.expired) env.connected=false;
      if (options.allDown || options.failed?.includes(name) || (options.expired && name==='loadApprovals')) {
        throw new Error('simulated panel failure');
      }
    };
  }
  const refresh = vm.runInNewContext(text+'; refresh',env) as () => Promise<void>;
  await refresh();
  return { state, messages, connected:env.connected };
}

test('C10 partial API failure does not falsely report the entire local agent disconnected',async()=>{
  const result=await simulate({failed:['loadRecovery']});
  assert.equal(result.connected,true);
  assert.equal(result.state.statusText.textContent,'Connected · 1 panel(s) unavailable');
  assert.equal(result.state.statusDot.className,'dot');
  assert.ok(result.messages.some(x=>x.includes('may be stale')));
});

test('C10 total API failure and expired cookie are explicitly distinguished',async()=>{
  const all=await simulate({allDown:true});
  assert.equal(all.state.statusText.textContent,'Agent unreachable');
  const expired=await simulate({expired:true});
  assert.equal(expired.state.statusText.textContent,'Signed out or session expired');
  assert.equal(expired.connected,false);
});

test('C10 healthy panels report connected without stale-panel warning',async()=>{
  const ok=await simulate();
  assert.equal(ok.state.statusText.textContent,'Connected');
  assert.equal(ok.state.statusDot.className,'dot ok');
  assert.equal(ok.messages.length,0);
});

test('C10 maintained partial-health implementation is present in generated served UI',async()=>{
  const html=renderControlCenter('nonce_control');
  assert.ok(html.includes('Promise.allSettled'));
  assert.ok(html.includes('panel(s) unavailable'));
  assert.ok(html.includes('Signed out or session expired'));
  assert.equal(html.includes('innerHTML'),false);
});
