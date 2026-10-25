import assert from 'node:assert/strict';
import test from 'node:test';
import { discoverBuiltInCapabilities } from '../src/core/capability-discovery.ts';
import type { ActionRequest, CapabilityProvider } from '../src/core/types.ts';

test('C02 provider discovery overlaps independent bounded probes without dispatch or reordering',async()=>{
  let active=0,maximum=0,requests=0,dispatches=0;
  const provider:CapabilityProvider={
    name:'deliberately-slow-test-provider',
    supports:async(action:ActionRequest)=>{
      active++;
      maximum=Math.max(maximum,active);
      requests++;
      try{
        await new Promise(resolve=>setTimeout(resolve,10));
        return action.capability==='file.read'||action.capability==='browser.inspect';
      }finally{active--;}
    },
    score:()=>({reliability:1,latency:1,determinism:1,security:1,
      reversibility:1,informationQuality:1,interactionCost:0}),
    execute:async()=>{dispatches++;throw new Error('discovery may never dispatch');}
  };
  const first=await discoverBuiltInCapabilities([provider]);
  assert.ok(requests>=50);
  assert.ok(maximum>1,'providers should not be discovered serially');
  assert.ok(maximum<=8,'bounded worker pool cannot swamp system probes');
  assert.equal(active,0);
  assert.equal(dispatches,0);
  assert.deepEqual(first.capabilities.map(x=>x.capability),
    [...first.capabilities.map(x=>x.capability)].sort());
  assert.equal(first.capabilities.find(x=>x.capability==='browser.inspect')?.status,'DECLARED_NOT_EXECUTED');
  assert.equal(first.capabilities.find(x=>x.capability==='file.read')?.status,'DECLARED_NOT_EXECUTED');
  assert.equal(first.capabilities.find(x=>x.capability==='file.write')?.status,'NOT_ADVERTISED_WITH_EMPTY_INPUT');
  const second=await discoverBuiltInCapabilities([provider]);
  assert.deepEqual(first,second,'parallel evaluation may not change capability truth or presentation order');
});

test('C02 stalled capability probes do not block all other declarations and stay indeterminate',async()=>{
  let dispatches=0;
  const provider:CapabilityProvider={
    name:'selectively-hung-probe',
    supports:(action:ActionRequest)=>action.capability==='browser.inspect'?
      new Promise<boolean>(()=>{}):action.capability==='git.status',
    score:()=>({reliability:1,latency:1,determinism:1,security:1,
      reversibility:1,informationQuality:1,interactionCost:0}),
    execute:async()=>{dispatches++;throw Error('forbidden');}
  };
  const report=await discoverBuiltInCapabilities([provider]);
  assert.equal(report.capabilities.find(x=>x.capability==='browser.inspect')?.status,'PROBE_INDETERMINATE');
  assert.equal(report.capabilities.find(x=>x.capability==='git.status')?.status,'DECLARED_NOT_EXECUTED');
  assert.equal(report.sourceTruth,'NOT_AN_EXECUTION_OR_AUTHORITY_GRANT');
  assert.equal(dispatches,0);
});
