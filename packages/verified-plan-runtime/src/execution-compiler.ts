import type { ExecutionCandidate, PlanNode, RankedExecutionCandidate } from './contracts.ts';

export interface ExecutionCompileOptions {
  remainingCostBudget?: number;
  maximumRisk?: number;
  requireRollbackForMutation?: boolean;
}

export function compileExecution(
  node:PlanNode,
  candidates:ExecutionCandidate[],
  options:ExecutionCompileOptions={}
):RankedExecutionCandidate[]{
  if(!Array.isArray(candidates)||candidates.length<1||candidates.length>100) throw new Error('execution candidates must contain 1-100 entries.');
  const budget=options.remainingCostBudget??Number.POSITIVE_INFINITY;
  if(budget!==Number.POSITIVE_INFINITY&&(!Number.isFinite(budget)||budget<0)) throw new Error('remainingCostBudget is invalid.');
  const maximumRisk=unit(options.maximumRisk??1,'maximumRisk');
  if(node.risk>maximumRisk) throw new Error('plan node risk exceeds hard maximumRisk constraint.');
  const requireRollback=options.requireRollbackForMutation??false;
  const normalized=candidates.map(normalize);
  if(new Set(normalized.map((candidate)=>candidate.id)).size!==normalized.length) throw new Error('execution candidate ids must be unique.');
  const allowed=new Set(node.allowedCapabilities);
  const eligible=normalized.filter((c)=>{
    if(!allowed.has(c.capability)) return false;
    if(c.expectedCost>budget) return false;
    if(c.mutating && node.kind==='OBSERVE') return false;
    if(c.mutating && requireRollback && !c.supportsRollback) return false;
    return true;
  });
  if(!eligible.length) throw new Error('no execution modality satisfies node capability/safety constraints.');
  return eligible.map((c)=>{
    const costPenalty=budget===Number.POSITIVE_INFINITY?Math.min(1,c.expectedCost/100)*0.08:budget===0?0:Math.min(1,c.expectedCost/budget)*0.16;
    const mutationPenalty=c.mutating?(node.reversible?0.03:0.12):0;
    const rollbackBonus=c.supportsRollback?0.05:0;
    const structureBonus=['API','MCP','APPLICATION','DOM','ACCESSIBILITY','UIA','PLAYWRIGHT'].includes(c.modality)?0.06:0;
    const utility=c.expectedSuccess*0.5+c.verificationStrength*0.18+structureBonus+rollbackBonus-c.uncertainty*0.2-costPenalty-mutationPenalty;
    const penalties:string[]=[];
    if(c.uncertainty>0.4) penalties.push('high-uncertainty');
    if(mutationPenalty>0.05) penalties.push('irreversible-mutation');
    if(costPenalty>0.08) penalties.push('cost-pressure');
    return {...c,utility:round(utility),penalties};
  }).sort((a,b)=>b.utility-a.utility||b.expectedSuccess-a.expectedSuccess||b.verificationStrength-a.verificationStrength||a.expectedCost-b.expectedCost||a.id.localeCompare(b.id));
}
function normalize(c:ExecutionCandidate):ExecutionCandidate{
  const modes=new Set(['GUI','DOM','ACCESSIBILITY','UIA','PLAYWRIGHT','APPLICATION','API','MCP','OBSERVE']);
  if(!c||typeof c!=='object'||!modes.has(c.modality)) throw new Error('execution candidate is invalid.');
  return {
    id:bounded(c.id,256,'execution.id'),modality:c.modality,capability:bounded(c.capability,512,'execution.capability'),
    expectedSuccess:unit(c.expectedSuccess,'execution.expectedSuccess'),expectedCost:finite(c.expectedCost,0,1e12,'execution.expectedCost'),
    uncertainty:unit(c.uncertainty,'execution.uncertainty'),verificationStrength:unit(c.verificationStrength,'execution.verificationStrength'),
    mutating:Boolean(c.mutating),supportsRollback:Boolean(c.supportsRollback)
  };
}
function bounded(v:unknown,m:number,l:string):string{if(typeof v!=='string'||!v||v.length>m)throw new Error(l+' is invalid.');return v;}
function finite(v:unknown,min:number,max:number,l:string):number{if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max)throw new Error(l+' is invalid.');return v;}
function unit(v:unknown,l:string):number{return finite(v,0,1,l);}
function round(v:number):number{return Math.round(v*1e6)/1e6;}
