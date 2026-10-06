import type { ActionDescriptor, ActionOutcome, StateSnapshot } from '../src/index.ts';

export interface SyntheticStep {
  action: ActionDescriptor;
  outcome: ActionOutcome;
  before: StateSnapshot;
  after: StateSnapshot;
}

export class SyntheticEnvironment {
  #facts = new Map<string, string>();
  #version = 0;
  #time: string;
  #scopeKey: string;

  constructor(input: { facts?: Record<string,string>; time?: string; scopeKey?: string } = {}) {
    for (const [key,value] of Object.entries(input.facts ?? {})) this.#facts.set(key,value);
    this.#time=input.time ?? '2026-10-05T00:00:00.000Z';
    this.#scopeKey=input.scopeKey ?? 'synthetic:scene';
  }

  snapshot(id='snapshot'): StateSnapshot {
    return {
      id,
      observedAt:this.#time,
      scopeKey:this.#scopeKey,
      stateVersion:'v'+this.#version,
      facts:[...this.#facts.entries()].sort((a,b)=>a[0].localeCompare(b[0])).map(([key,valueDigest])=>({
        key,
        valueDigest,
        confidence:1,
        evidence:[{digest:valueDigest,source:'synthetic-environment',observedAt:this.#time}]
      }))
    };
  }

  run(input:{
    action:ActionDescriptor;
    mutations?:Record<string,string|null>;
    externalMutations?:Record<string,string|null>;
    outcome?:Partial<ActionOutcome>;
  }):SyntheticStep{
    const before=this.snapshot('before-'+this.#version);
    for(const [key,value] of Object.entries(input.mutations??{})) this.#apply(key,value);
    for(const [key,value] of Object.entries(input.externalMutations??{})) this.#apply(key,value);
    if(Object.keys(input.mutations??{}).length||Object.keys(input.externalMutations??{}).length) this.#version+=1;
    const after=this.snapshot('after-'+this.#version);
    const outcome:ActionOutcome={
      ok:true,
      sideEffectState:'known',
      executionPhase:'effect_observed',
      evidence:[],
      ...input.outcome
    };
    return {action:structuredClone(input.action),outcome,before,after};
  }

  #apply(key:string,value:string|null):void{
    if(value===null) this.#facts.delete(key);
    else this.#facts.set(key,value);
  }
}
