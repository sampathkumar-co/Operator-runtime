import crypto from 'node:crypto';
import type {
  BeliefView, CompiledGoal, ExecutionObservation, PlanDecisionLineage, PlanGraph, PlanNodeState,
  VerificationReceiptRef, PlanRepairDecision
} from './contracts.ts';
import { validatePlanGraph, initializeNodeStates } from './plan-graph.ts';
import { bindPlanToBeliefs } from './belief-binding.ts';
import { assessNodeOutcome, planLocalRepair } from './plan-monitor.ts';
import { validateCompletionReceipt } from './commit-protocol.ts';
import { canonical } from './lineage.ts';

export interface VerifiedPlanRuntimeState {
  version:1;
  goal:CompiledGoal;
  graph:PlanGraph;
  nodeStates:PlanNodeState[];
  decisions:PlanDecisionLineage[];
}

export class VerifiedPlanRuntime {
  readonly goal:CompiledGoal;
  readonly graph:PlanGraph;
  #states:PlanNodeState[];
  #decisions:PlanDecisionLineage[];

  constructor(goal:CompiledGoal,graphInput:PlanGraph,state?:VerifiedPlanRuntimeState){
    const graph=validatePlanGraph(goal,graphInput);
    this.goal=structuredClone(goal);
    this.graph=graph;
    if(state){
      if(state.version!==1) throw new Error('unsupported verified plan runtime state version.');
      if(state.goal.id!==goal.id||state.graph.planId!==graph.planId||state.graph.version!==graph.version){
        throw new Error('runtime state is bound to different goal/plan lineage.');
      }
      const expectedIds=new Set(graph.nodes.map((n)=>n.id));
      if(state.nodeStates.length!==expectedIds.size||state.nodeStates.some((s)=>!expectedIds.has(s.nodeId))){
        throw new Error('runtime node state does not match plan graph.');
      }
      this.#states=structuredClone(state.nodeStates);
      this.#decisions=structuredClone(state.decisions);
    }else{
      this.#states=initializeNodeStates(graph);
      this.#decisions=[];
    }
  }

  static fromState(state:VerifiedPlanRuntimeState):VerifiedPlanRuntime{
    return new VerifiedPlanRuntime(state.goal,state.graph,state);
  }

  bindBeliefs(beliefs:BeliefView[],now?:string){
    const result=bindPlanToBeliefs(this.graph,this.#states,beliefs,now);
    this.#states=result.states;
    return structuredClone(result);
  }

  startNode(nodeId:string,now=new Date().toISOString()):PlanNodeState{
    const node=this.node(nodeId);
    const state=this.stateFor(nodeId);
    if(state.status!=='READY') throw new Error('node is not ready: '+nodeId);
    if(state.attempts>=node.maxAttempts) throw new Error('node attempt budget exhausted: '+nodeId);
    const next={...state,status:'RUNNING' as const,attempts:state.attempts+1,lastReason:undefined,lastUpdatedAt:now};
    this.replaceState(next);
    return structuredClone(next);
  }

  recordExecution(nodeId:string,observation:ExecutionObservation,now=new Date().toISOString()):{
    state:PlanNodeState; repair?:PlanRepairDecision;
  }{
    const node=this.node(nodeId);
    const current=this.stateFor(nodeId);
    if(current.status!=='RUNNING') throw new Error('node must be RUNNING before execution outcome is recorded.');
    const assessment=assessNodeOutcome(node,observation);
    if(!assessment.accepted){
      const failed={...current,status:'FAILED' as const,lastReason:assessment.reason,lastUpdatedAt:now};
      this.replaceState(failed);
      const repair=planLocalRepair(this.graph,this.#states,nodeId,assessment.reason);
      const invalidated=new Set(repair.invalidatedNodeIds);
      this.#states=this.#states.map((s)=>{
        if(s.nodeId===nodeId) return failed;
        if(invalidated.has(s.nodeId)&&s.status!=='SUCCEEDED') return {...s,status:'INVALIDATED' as const,lastReason:'local-repair-invalidated',lastUpdatedAt:now};
        return s;
      });
      return {state:structuredClone(failed),repair};
    }
    const next={
      ...current,
      status:(assessment.requiresVerification?'BLOCKED':'SUCCEEDED') as PlanNodeState['status'],
      lastReason:assessment.reason,
      lastUpdatedAt:now
    };
    this.replaceState(next);
    return {state:structuredClone(next)};
  }

  markVerifiedComplete(nodeId:string,receipt:VerificationReceiptRef,now=new Date().toISOString()):PlanNodeState{
    const node=this.node(nodeId);
    const state=this.stateFor(nodeId);
    if(state.status!=='BLOCKED'&&state.status!=='RUNNING') throw new Error('node is not awaiting verification.');
    if(node.verificationFactKeys.length===0) throw new Error('node does not require independent verification.');
    validateCompletionReceipt(receipt,this.goal.id,nodeId);
    const next={...state,status:'SUCCEEDED' as const,lastReason:'independent-verification-receipt-accepted',lastUpdatedAt:now};
    this.replaceState(next);
    return structuredClone(next);
  }

  appendDecision(decision:PlanDecisionLineage):void{
    if(decision.planId!==this.graph.planId||decision.planVersion!==this.graph.version||decision.goalId!==this.goal.id){
      throw new Error('decision lineage is bound to a different plan.');
    }
    if(!this.graph.nodes.some((n)=>n.id===decision.nodeId)) throw new Error('decision lineage references unknown node.');
    if(this.#decisions.some((d)=>d.digest===decision.digest)) return;
    this.#decisions.push(structuredClone(decision));
    if(this.#decisions.length>100_000) this.#decisions.splice(0,this.#decisions.length-100_000);
  }

  states():PlanNodeState[]{return structuredClone(this.#states);}
  decisions():PlanDecisionLineage[]{return structuredClone(this.#decisions);}
  exportState():VerifiedPlanRuntimeState{
    return {version:1,goal:structuredClone(this.goal),graph:structuredClone(this.graph),nodeStates:this.states(),decisions:this.decisions()};
  }
  stateDigest():string{return crypto.createHash('sha256').update(canonical(this.exportState())).digest('hex');}

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
