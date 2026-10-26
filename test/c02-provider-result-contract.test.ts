import assert from 'node:assert/strict';
import test from 'node:test';
import { assertProviderResultContract } from '../src/core/provider-result-contract.ts';
import { OperatorRuntime } from '../src/core/runtime.ts';
import { evidence } from '../src/core/evidence.ts';
import type { ActionRequest, ActionResult, CapabilityProvider, CapabilityScore } from '../src/core/types.ts';

const action:ActionRequest={
  id:'provider-contract-test',
  capability:'computer.inspect',
  risk:'read',
  input:{},provenance:{kind:'runtime'}
};
const valid=():ActionResult=>({
  ok:true,capability:action.capability,provider:'probe',
  evidence:[evidence('result','pass','Observation returned from current provider.')],
  durationMs:1,
  output:{value:42}
});
const score:CapabilityScore={reliability:1,latency:1,determinism:1,security:1,
  reversibility:1,informationQuality:1,interactionCost:0};

test('C02 action results require exact provider and capability identities, never coerced',()=>{
  assert.equal(assertProviderResultContract(valid(),action,'probe').ok,true);
  let coercions=0;
  const hostile={toString(){coercions++;return 'computer.inspect';}};
  const broken=[
    {...valid(),capability:['computer.inspect']},
    {...valid(),capability:hostile},
    {...valid(),provider:['probe']},
    {...valid(),provider:'another-provider'},
    {...valid(),ok:'true'},
    {...valid(),ok:1},
    {...valid(),durationMs:'1'},
    {...valid(),durationMs:Infinity},
    {...valid(),durationMs:-1},
    {...valid(),durationMs:24 * 60 * 60_000 + 1},
    {...valid(),evidence:[{...evidence('test','pass','noncanonical'),timestamp:'2026-10-25'}]},
    {...valid(),evidence:[{...evidence('test','pass','timezone variant'),timestamp:'2026-10-25T00:00:00+00:00'}]},

    {...valid(),evidence:{}},
    {...valid(),evidence:Array(257).fill(evidence('test','info','overflow'))},
    {...valid(),evidence:[{...evidence('test','pass','ok'),status:['pass']}]},
    {...valid(),evidence:[{...evidence('test','pass','ok'),timestamp:['2026-10-25T12:00:00.000Z']}]},
    {...valid(),error:{code:'SHOULD_NOT_EXIST',message:'success with error'}},
    {...valid(),ok:false,error:{code:['READ_FAILED'],message:'bad'}},
    {...valid(),ok:false,error:{code:'READ_FAILED',message:'bad',sideEffectState:['none']}}
  ];
  for(const [index,result] of broken.entries()){
    assert.throws(()=>assertProviderResultContract(result,action,'probe'),
      (error:any)=>error?.code==='PROVIDER_RESULT_CONTRACT_INVALID' &&
        error?.details?.executionPhase==='dispatched' &&
        error?.details?.sideEffectState==='uncertain','case '+index);
  }
  assert.equal(coercions,0);
});

test('C02 central runtime cannot turn a provider result for another capability into success',async()=>{
  let executed=0;
  const provider:CapabilityProvider={
    name:'probe',
    supports:(request)=>request.capability===action.capability,
    score:()=>score,
    async execute(request){
      executed++;
      return {...valid(),capability:'terminal.execute'};
    }
  };
  const runtime=new OperatorRuntime().register(provider);
  try{
    const output=await runtime.execute(action,{allowedCapabilities:['computer.inspect'],allowedRoots:[]});
    assert.equal(executed,1);
    assert.equal(output.ok,false);
    assert.equal(output.error?.code,'PROVIDER_RESULT_CONTRACT_INVALID');
    assert.equal(output.capability,action.capability);
  }finally{await runtime.close();}
});

test('C02 central runtime preserves genuine provider success with canonical identities',async()=>{
  const runtime=new OperatorRuntime().register({
    name:'probe',
    supports:(request)=>request.capability===action.capability,
    score:()=>score,
    async execute(){return valid();}
  });
  try{
    const result=await runtime.execute(action,{allowedCapabilities:['computer.inspect'],allowedRoots:[]});
    assert.equal(result.ok,true,result.error?.message);
    assert.equal(result.capability,action.capability);
    assert.equal(result.provider,'probe');
    assert.ok(result.evidence.some(e=>e.kind==='routing'));
  }finally{await runtime.close();}
});

test('C02 provider receipts retain legitimate fractional time and canonical evidence timestamp', () => {
  const canonical = valid();
  canonical.durationMs = 0.125;
  assert.equal(assertProviderResultContract(canonical, action, 'probe').durationMs, 0.125);
});
