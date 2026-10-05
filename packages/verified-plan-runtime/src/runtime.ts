import crypto from 'node:crypto';
import type {
  BeliefView, CompiledGoal, ExecutionObservation, PlanDecisionLineage, PlanGraph, PlanNodeState,
  VerificationReceiptRef, PlanRepairDecision
} from './contracts.ts';
import { validatePlanGraph, initializeNodeStates } from './plan-graph.ts';
import { bindPlanToBeliefs } from './belief-binding.ts';
import { assessNodeOutcome, planLocalRepair } from './plan-monitor.ts';
import { validateCompletionReceipt } from './commit-protocol.ts';
import { canonical, digestPlan, validateDecisionLineage } from './lineage.ts';

export interface VerifiedPlanRuntimeState {
  version:2;
  goal:CompiledGoal;
  graph:PlanGraph;
  goalDigest:string;
  planDigest:string;
  nodeStates:PlanNodeState[];
  decisions:PlanDecisionLineage[];
  verificationReceipts:VerificationReceiptRef[];
}

export interface VerifiedPlanRuntimeEnvelope {
  kind:'verified-plan-runtime';
  envelopeVersion:1;
  payload:VerifiedPlanRuntimeState;
  payloadDigest:string;
}

export class VerifiedPlanRuntime {
  readonly goal:CompiledGoal;
  readonly graph:PlanGraph;
  readonly goalDigest:string;
  readonly planDigest:string;
  #states:PlanNodeState[];
  #decisions:PlanDecisionLineage[];
  #receipts:VerificationReceiptRef[];

  constructor(goal:CompiledGoal,graphInput:PlanGraph,state?:VerifiedPlanRuntimeState){
    const graph=validatePlanGraph(goal,graphInput);
    this.goal=structuredClone(goal);
    this.graph=graph;
    this.goalDigest=digestPlan(this.goal);
    this.planDigest=digestPlan(this.graph);

    if(state){
      if(state.version!==2) throw new Error('unsupported verified plan runtime state version.');
      if(state.goal.id!==goal.id||state.graph.planId!==graph.planId||state.graph.version!==graph.version){
        throw new Error('runtime state is bound to different goal/plan lineage.');
      }
      if(sha256(state.goalDigest,'state.goalDigest')!==this.goalDigest||sha256(state.planDigest,'state.planDigest')!==this.planDigest){
        throw new Error('runtime state goal/plan digest does not match immutable content.');
      }
      this.#states=normalizeNodeStates(graph,state.nodeStates);
      this.#decisions=state.decisions.map(validateDecisionLineage);
      for(const decision of this.#decisions){
        if(decision.planId!==graph.planId||decision.planVersion!==graph.version||decision.planDigest!==this.planDigest||decision.goalId!==goal.id){
          throw new Error('persisted decision lineage is bound to different plan content.');
        }
        if(!graph.nodes.some((n)=>n.id===decision.nodeId)) throw new Error('persisted decision references unknown node.');
      }
      this.#receipts=structuredClone(state.verificationReceipts??[]);
      this.validatePersistedReceipts();
    }else{
      this.#states=initializeNodeStates(graph);
      this.#decisions=[];
      this.#receipts=[];
    }
  }

  static fromState(state:VerifiedPlanRuntimeState):VerifiedPlanRuntime{
    return new VerifiedPlanRuntime(state.goal,state.graph,state);
  }

  static fromEnvelope(input:VerifiedPlanRuntimeEnvelope):VerifiedPlanRuntime{
    if(!input||typeof input!=='object'||input.kind!=='verified-plan-runtime'||input.envelopeVersion!==1){
      throw new Error('verified plan runtime envelope is invalid.');
    }
    const expected=digestPlan(input.payload);
    if(sha256(input.payloadDigest,'envelope.payloadDigest')!==expected){
      throw new Error('verified plan runtime envelope payload digest mismatch.');
    }
    return VerifiedPlanRuntime.fromState(input.payload);
  }

  bindBeliefs(beliefs:BeliefView[],now?:string){
    if(this.#states.some((state)=>state.status==='RUNNING')){
      throw new Error('belief rebinding is forbidden while an execution node is running.');
    }
    const result=bindPlanToBeliefs(this.graph,this.#states,beliefs,now);
    this.#states=result.states;
    return structuredClone(result);
  }

  startNode(nodeId:string,now=new Date().toISOString()):PlanNodeState{
    validIso(now,'now');
    const node=this.node(nodeId);
    const state=this.stateFor(nodeId);
    if(state.status!=='READY') throw new Error('node is not ready: '+nodeId);
    if(state.attempts>=node.maxAttempts) throw new Error('node attempt budget exhausted: '+nodeId);
    const next={
      ...state,status:'RUNNING' as const,attempts:state.attempts+1,lastReason:undefined,
      lastExecutionDigest:undefined,verificationReceiptDigest:undefined,lastUpdatedAt:now
    };
    this.replaceState(next);
    return structuredClone(next);
  }

  recordExecution(nodeId:string,observationInput:ExecutionObservation,now=new Date().toISOString()):{
    state:PlanNodeState; executionDigest:string; repair?:PlanRepairDecision;
  }{
    validIso(now,'now');
    const node=this.node(nodeId);
    const current=this.stateFor(nodeId);
    if(current.status!=='RUNNING') throw new Error('node must be RUNNING before execution outcome is recorded.');
    const observation=normalizeObservation(observationInput);
    const executionDigest=digestPlan({
      goalDigest:this.goalDigest,planDigest:this.planDigest,nodeId,attempt:current.attempts,observation
    });
    const assessment=assessNodeOutcome(node,observation);
    if(!assessment.accepted){
      const failed={...current,status:'FAILED' as const,lastExecutionDigest:executionDigest,lastReason:assessment.reason,lastUpdatedAt:now};
      this.replaceState(failed);
      const repair=planLocalRepair(this.graph,this.#states,nodeId,assessment.reason);
      const invalidated=new Set(repair.invalidatedNodeIds);
      this.#states=this.#states.map((s)=>{
        if(s.nodeId===nodeId) return failed;
        if(invalidated.has(s.nodeId)&&s.status!=='SUCCEEDED') return {...s,status:'INVALIDATED' as const,lastReason:'local-repair-invalidated',lastUpdatedAt:now};
        return s;
      });
      return {state:structuredClone(failed),executionDigest,repair};
    }
    const next={
      ...current,lastExecutionDigest:executionDigest,
      status:(assessment.requiresVerification?'BLOCKED':'SUCCEEDED') as PlanNodeState['status'],
      lastReason:assessment.reason,lastUpdatedAt:now
    };
    this.replaceState(next);
    return {state:structuredClone(next),executionDigest};
  }

  markVerifiedComplete(nodeId:string,receipt:VerificationReceiptRef,now=new Date().toISOString()):PlanNodeState{
    validIso(now,'now');
    const node=this.node(nodeId);
    const state=this.stateFor(nodeId);
    if(state.status!=='BLOCKED'&&state.status!=='RUNNING') throw new Error('node is not awaiting verification.');
    if(node.verificationFactKeys.length===0) throw new Error('node does not require independent verification.');
    if(!state.lastExecutionDigest) throw new Error('node has no exact execution lineage to verify.');
    const normalized=validateCompletionReceipt(receipt,{
      goalId:this.goal.id,planId:this.graph.planId,planVersion:this.graph.version,nodeId,
      attempt:state.attempts,executionDigest:state.lastExecutionDigest
    });
    if(!this.#receipts.some((r)=>r.digest===normalized.digest)) this.#receipts.push(structuredClone(normalized));
    const next={
      ...state,status:'SUCCEEDED' as const,verificationReceiptDigest:normalized.digest,
      lastReason:'independent-verification-receipt-accepted',lastUpdatedAt:now
    };
    this.replaceState(next);
    return structuredClone(next);
  }

  appendDecision(decisionInput:PlanDecisionLineage):void{
    const decision=validateDecisionLineage(decisionInput);
    if(decision.planId!==this.graph.planId||decision.planVersion!==this.graph.version||
       decision.planDigest!==this.planDigest||decision.goalId!==this.goal.id){
      throw new Error('decision lineage is bound to a different plan.');
    }
    if(!this.graph.nodes.some((n)=>n.id===decision.nodeId)) throw new Error('decision lineage references unknown node.');
    if(this.#decisions.some((d)=>d.digest===decision.digest)) return;
    this.#decisions.push(structuredClone(decision));
    if(this.#decisions.length>100_000) this.#decisions.splice(0,this.#decisions.length-100_000);
  }

  states():PlanNodeState[]{return structuredClone(this.#states);}
  decisions():PlanDecisionLineage[]{return structuredClone(this.#decisions);}
  verificationReceipts():VerificationReceiptRef[]{return structuredClone(this.#receipts);}

  exportState():VerifiedPlanRuntimeState{
    return {
      version:2,goal:structuredClone(this.goal),graph:structuredClone(this.graph),
      goalDigest:this.goalDigest,planDigest:this.planDigest,nodeStates:this.states(),
      decisions:this.decisions(),verificationReceipts:this.verificationReceipts()
    };
  }
  exportEnvelope():VerifiedPlanRuntimeEnvelope{
    const payload=this.exportState();
    return {kind:'verified-plan-runtime',envelopeVersion:1,payload,payloadDigest:digestPlan(payload)};
  }
  stateDigest():string{return crypto.createHash('sha256').update(canonical(this.exportState())).digest('hex');}

  private validatePersistedReceipts():void{
    const seen=new Set<string>();
    for(const receipt of this.#receipts){
      if(seen.has(receipt.digest)) throw new Error('persisted verification receipt digest is duplicated.');
      seen.add(receipt.digest);
      const state=this.stateFor(receipt.nodeId);
      if(!state.lastExecutionDigest) throw new Error('persisted receipt has no matching execution lineage.');
      validateCompletionReceipt(receipt,{
        goalId:this.goal.id,planId:this.graph.planId,planVersion:this.graph.version,nodeId:receipt.nodeId,
        attempt:state.attempts,executionDigest:state.lastExecutionDigest
      });
    }
    for(const node of this.graph.nodes){
      const state=this.stateFor(node.id);
      if(state.status==='SUCCEEDED'&&node.verificationFactKeys.length>0){
        if(!state.verificationReceiptDigest) throw new Error('verified node is missing persisted receipt lineage.');
        if(!this.#receipts.some((r)=>r.digest===state.verificationReceiptDigest)){
          throw new Error('verified node references a missing persisted receipt.');
        }
      }
    }
  }

  private node(id:string){
    const node=this.graph.nodes.find((n)=>n.id===id);
    if(!node) throw new Error('unknown plan node: '+id);
    return node;
  }
  private stateFor(id:string){
    const s=this.#states.find((x)=>x.nodeId===id);
    if(!s) throw new Error('missing plan node state: '+id);
    return s;
  }
  private replaceState(next:PlanNodeState):void{
    this.#states=this.#states.map((s)=>s.nodeId===next.nodeId?next:s);
  }
}

function normalizeNodeStates(graph:PlanGraph,input:PlanNodeState[]):PlanNodeState[]{
  if(!Array.isArray(input)||input.length!==graph.nodes.length) throw new Error('runtime node state does not match plan graph.');
  const validStatuses=new Set(['PENDING','READY','RUNNING','BLOCKED','INVALIDATED','SUCCEEDED','FAILED','SKIPPED']);
  const byNode=new Map(graph.nodes.map((n)=>[n.id,n]));
  const seen=new Set<string>();
  return input.map((s)=>{
    if(!s||typeof s!=='object'||!byNode.has(s.nodeId)||seen.has(s.nodeId)) throw new Error('runtime node state is invalid.');
    seen.add(s.nodeId);
    if(!validStatuses.has(s.status)) throw new Error('runtime node status is invalid.');
    const node=byNode.get(s.nodeId)!;
    if(!Number.isSafeInteger(s.attempts)||s.attempts<0||s.attempts>node.maxAttempts) throw new Error('runtime node attempts are invalid.');
    validIso(s.lastUpdatedAt,'node.lastUpdatedAt');
    if(s.lastExecutionDigest) sha256(s.lastExecutionDigest,'node.lastExecutionDigest');
    if(s.verificationReceiptDigest) sha256(s.verificationReceiptDigest,'node.verificationReceiptDigest');
    return structuredClone(s);
  });
}

function normalizeObservation(input:ExecutionObservation):ExecutionObservation{
  if(!input||typeof input!=='object') throw new Error('execution observation is required.');
  const side=new Set(['none','known','uncertain']);
  if(typeof input.executionOk!=='boolean'||!side.has(input.sideEffectState)) throw new Error('execution observation is invalid.');
  return {
    changedFactKeys:uniqueStrings(input.changedFactKeys,'changedFactKey'),
    supportedFactKeys:uniqueStrings(input.supportedFactKeys,'supportedFactKey'),
    contradictedFactKeys:uniqueStrings(input.contradictedFactKeys,'contradictedFactKey'),
    executionOk:input.executionOk,sideEffectState:input.sideEffectState,
    ...(input.evidenceDigests?{evidenceDigests:uniqueStrings(input.evidenceDigests,'evidenceDigest').map((v)=>sha256(v,'evidenceDigest'))}:{})
  };
}
function uniqueStrings(input:unknown,label:string):string[]{
  if(!Array.isArray(input)||input.length>10_000) throw new Error(label+' list is invalid.');
  const values=input.map((v)=>{if(typeof v!=='string'||!v||v.length>512)throw new Error(label+' is invalid.');return v;});
  return [...new Set(values)].sort();
}
function sha256(v:unknown,l:string):string{if(typeof v!=='string'||!/^[0-9a-fA-F]{64}$/.test(v))throw new Error(l+' must be SHA-256.');return v.toLowerCase();}
function validIso(v:unknown,l:string):string{if(typeof v!=='string')throw new Error(l+' is invalid.');const p=Date.parse(v);if(!Number.isFinite(p)||new Date(p).toISOString()!==v)throw new Error(l+' must be ISO timestamp.');return v;}
