import type { BeliefView, CompiledGoal, PlanGraph, VerificationReceiptRef } from '../src/index.ts';

export const D='a'.repeat(64);
export const E='b'.repeat(64);

export function goal():CompiledGoal{
  return {
    id:'goal-1',kind:'web-task',objective:'Find and safely complete the requested operation.',
    successFactKeys:['goal.done'],forbiddenFactKeys:['goal.forbidden'],constraints:[],unresolvedAssumptions:[]
  };
}

export function graph():PlanGraph{
  return {
    planId:'plan-1',goalId:'goal-1',version:1,rootNodeIds:['observe'],
    nodes:[
      {
        id:'observe',kind:'OBSERVE',title:'Observe current state',dependsOn:[],preconditions:[],
        expectedEffects:['state.observed'],verificationFactKeys:[],allowedCapabilities:['browser.read'],
        expectedCost:1,risk:0,reversible:true,maxAttempts:2
      },
      {
        id:'act',kind:'ACTION',title:'Apply requested change',parentId:'observe',dependsOn:['observe'],
        preconditions:[{factKey:'state.observed',minimumConfidence:0.6}],expectedEffects:['change.applied'],
        verificationFactKeys:['change.verified'],allowedCapabilities:['browser.write'],expectedCost:2,risk:0.4,
        reversible:true,maxAttempts:2
      },
      {
        id:'verify',kind:'VERIFY',title:'Verify result',parentId:'observe',dependsOn:['act'],
        preconditions:[{factKey:'change.applied'}],expectedEffects:['goal.done'],verificationFactKeys:['goal.done'],
        allowedCapabilities:['browser.read'],expectedCost:1,risk:0,reversible:true,maxAttempts:2
      }
    ]
  };
}

export function belief(factKey:string,status:BeliefView['status']='KNOWN',confidence=0.95):BeliefView{
  return {factKey,status,confidence,selectedValueDigest:D,evidenceDigests:[E]};
}

export function receipt(nodeId:string,goalId='goal-1'):VerificationReceiptRef{
  return {
    digest:D,goalId,nodeId,verifierId:'verification-kernel',
    verifiedAt:'2026-10-05T10:00:00.000Z',authoritySnapshotDigest:E
  };
}
