import type { PlanBranchCandidate, RankedPlanBranch } from './contracts.ts';

export interface PlanSearchOptions {
  remainingCostBudget?: number;
  maximumRisk?: number;
}

export function rankPlanBranches(candidates:PlanBranchCandidate[],options:PlanSearchOptions={}):RankedPlanBranch[]{
  if(!Array.isArray(candidates)||candidates.length<1||candidates.length>500) throw new Error('plan candidates must contain 1-500 entries.');
  const budget=options.remainingCostBudget ?? Number.POSITIVE_INFINITY;
  const maxRisk=options.maximumRisk ?? 1;
  if((budget!==Number.POSITIVE_INFINITY)&&(!Number.isFinite(budget)||budget<0)) throw new Error('remainingCostBudget is invalid.');
  if(!Number.isFinite(maxRisk)||maxRisk<0||maxRisk>1) throw new Error('maximumRisk is invalid.');
  const normalized=candidates.map(normalize);
  if(new Set(normalized.map((candidate)=>candidate.id)).size!==normalized.length) throw new Error('plan branch candidate ids must be unique.');
  const eligible=normalized.filter((c)=>c.expectedCost<=budget&&c.risk<=maxRisk);
  if(!eligible.length) throw new Error('no plan branch satisfies hard budget/risk constraints.');
  return eligible.map((c)=>{
    const costPenalty=budget===Number.POSITIVE_INFINITY?Math.min(1,c.expectedCost/100)*0.08:budget===0?0:Math.min(1,c.expectedCost/budget)*0.18;
    const riskPenalty=c.risk*0.34;
    const uncertaintyPenalty=c.uncertainty*0.2;
    const lengthPenalty=Math.min(1,c.nodeIds.length/50)*0.05;
    const utility=
      c.expectedSuccess*0.42+
      c.expectedInformationGain*0.12+
      c.verificationStrength*0.15+
      c.reversibleFraction*0.08-
      costPenalty-riskPenalty-uncertaintyPenalty-lengthPenalty;
    const penalties:string[]=[];
    if(costPenalty>0.08) penalties.push('cost-pressure');
    if(c.risk>0.4) penalties.push('high-risk');
    if(c.uncertainty>0.4) penalties.push('high-uncertainty');
    if(c.reversibleFraction<0.5) penalties.push('low-reversibility');
    return {...c,utility:round(utility),penalties};
  }).sort((a,b)=>b.utility-a.utility||b.expectedSuccess-a.expectedSuccess||b.verificationStrength-a.verificationStrength||a.expectedCost-b.expectedCost||a.id.localeCompare(b.id));
}
function normalize(c:PlanBranchCandidate):PlanBranchCandidate{
  if(!c||typeof c!=='object') throw new Error('plan branch candidate is required.');
  if(!Array.isArray(c.nodeIds)||c.nodeIds.length<1||c.nodeIds.length>1000) throw new Error('candidate.nodeIds is invalid.');
  return {
    id:bounded(c.id,256,'candidate.id'),
    nodeIds:[...new Set(c.nodeIds.map((v)=>bounded(v,256,'candidate.nodeId')))],
    expectedSuccess:unit(c.expectedSuccess,'candidate.expectedSuccess'),
    expectedInformationGain:unit(c.expectedInformationGain,'candidate.expectedInformationGain'),
    expectedCost:finite(c.expectedCost,0,1e12,'candidate.expectedCost'),
    risk:unit(c.risk,'candidate.risk'),
    uncertainty:unit(c.uncertainty,'candidate.uncertainty'),
    verificationStrength:unit(c.verificationStrength,'candidate.verificationStrength'),
    reversibleFraction:unit(c.reversibleFraction,'candidate.reversibleFraction')
  };
}
function bounded(v:unknown,m:number,l:string):string{if(typeof v!=='string'||!v||v.length>m)throw new Error(l+' is invalid.');return v;}
function finite(v:unknown,min:number,max:number,l:string):number{if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max)throw new Error(l+' is invalid.');return v;}
function unit(v:unknown,l:string):number{return finite(v,0,1,l);}
function round(v:number):number{return Math.round(v*1e6)/1e6;}
