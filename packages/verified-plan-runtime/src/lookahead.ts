import type { PlanBranchCandidate } from './contracts.ts';

export interface AbstractPlanningState {
  facts:string[];
}

export interface PlanningOperator {
  id:string;
  requires:string[];
  adds:string[];
  removes:string[];
  expectedSuccess:number;
  expectedInformationGain:number;
  expectedCost:number;
  risk:number;
  verificationStrength:number;
  reversible:boolean;
}

export interface LookaheadOptions {
  maxDepth?:number;
  beamWidth?:number;
  maximumExpandedStates?:number;
  remainingCostBudget?:number;
  maximumRisk?:number;
}

export interface LookaheadPlan {
  candidate:PlanBranchCandidate;
  resultingFacts:string[];
  goalSatisfied:boolean;
}

interface Frontier {
  facts:Set<string>;
  operatorIds:string[];
  success:number;
  infoComplement:number;
  cost:number;
  riskComplement:number;
  verificationTotal:number;
  reversibleCount:number;
}

export function searchCounterfactualPlans(
  initial:AbstractPlanningState,
  operatorsInput:PlanningOperator[],
  successFactKeys:string[],
  forbiddenFactKeys:string[]=[],
  options:LookaheadOptions={}
):LookaheadPlan[]{
  if(!Array.isArray(initial.facts)) throw new Error('initial facts are required.');
  if(!Array.isArray(operatorsInput)||operatorsInput.length<1||operatorsInput.length>1000) throw new Error('planning operators must contain 1-1000 entries.');
  const operators=operatorsInput.map(normalizeOperator);
  const maxDepth=integer(options.maxDepth??6,1,20,'maxDepth');
  const beamWidth=integer(options.beamWidth??20,1,200,'beamWidth');
  const maxExpanded=integer(options.maximumExpandedStates??5000,1,100_000,'maximumExpandedStates');
  const budget=options.remainingCostBudget??Number.POSITIVE_INFINITY;
  const maxRisk=unit(options.maximumRisk??1,'maximumRisk');
  if(budget!==Number.POSITIVE_INFINITY&&(!Number.isFinite(budget)||budget<0)) throw new Error('remainingCostBudget is invalid.');
  const goal=unique(successFactKeys.map((v)=>bounded(v,512,'successFactKey')));
  if(!goal.length) throw new Error('lookahead requires at least one success fact.');
  const forbidden=new Set(unique(forbiddenFactKeys.map((v)=>bounded(v,512,'forbiddenFactKey'))));

  let frontier:Frontier[]=[{
    facts:new Set(unique(initial.facts.map((v)=>bounded(v,512,'initial.fact')))),
    operatorIds:[],success:1,infoComplement:1,cost:0,riskComplement:1,verificationTotal:0,reversibleCount:0
  }];
  const completed:Frontier[]=[];
  const bestByState=new Map<string,number>();
  let expanded=0;

  for(let depth=0;depth<maxDepth&&frontier.length;depth+=1){
    const next:Frontier[]=[];
    for(const current of frontier){
      for(const op of operators){
        if(expanded>=maxExpanded) break;
        if(!op.requires.every((f)=>current.facts.has(f))) continue;
        const cost=current.cost+op.expectedCost;
        if(cost>budget) continue;
        const risk=1-(current.riskComplement*(1-op.risk));
        if(risk>maxRisk) continue;
        const facts=new Set(current.facts);
        for(const f of op.removes) facts.delete(f);
        for(const f of op.adds) facts.add(f);
        if([...forbidden].some((f)=>facts.has(f))) continue;
        const successor:Frontier={
          facts,operatorIds:[...current.operatorIds,op.id],
          success:current.success*op.expectedSuccess,
          infoComplement:current.infoComplement*(1-op.expectedInformationGain),
          cost,riskComplement:current.riskComplement*(1-op.risk),
          verificationTotal:current.verificationTotal+op.verificationStrength,
          reversibleCount:current.reversibleCount+(op.reversible?1:0)
        };
        expanded+=1;
        const signature=stateSignature(successor.facts);
        const heuristic=scoreFrontier(successor,goal);
        const previous=bestByState.get(signature);
        if(previous!==undefined&&previous>=heuristic) continue;
        bestByState.set(signature,heuristic);
        if(goal.every((f)=>facts.has(f))) completed.push(successor);
        else next.push(successor);
      }
      if(expanded>=maxExpanded) break;
    }
    frontier=next.sort((a,b)=>scoreFrontier(b,goal)-scoreFrontier(a,goal)||a.cost-b.cost||a.operatorIds.join('|').localeCompare(b.operatorIds.join('|'))).slice(0,beamWidth);
  }

  const source=completed.length?completed:frontier;
  return source.map((item,index)=>toPlan(item,goal,index)).sort((a,b)=>{
    if(a.goalSatisfied!==b.goalSatisfied) return a.goalSatisfied?-1:1;
    return branchUtility(b.candidate)-branchUtility(a.candidate)||a.candidate.expectedCost-b.candidate.expectedCost||a.candidate.id.localeCompare(b.candidate.id);
  }).slice(0,beamWidth);
}

function toPlan(item:Frontier,goal:string[],index:number):LookaheadPlan{
  const steps=Math.max(1,item.operatorIds.length);
  return {
    candidate:{
      id:'lookahead-'+index+'-'+item.operatorIds.join('>'),
      nodeIds:[...item.operatorIds],
      expectedSuccess:round(item.success),
      expectedInformationGain:round(1-item.infoComplement),
      expectedCost:round(item.cost),
      risk:round(1-item.riskComplement),
      uncertainty:round(1-item.success),
      verificationStrength:round(item.verificationTotal/steps),
      reversibleFraction:round(item.reversibleCount/steps)
    },
    resultingFacts:[...item.facts].sort(),
    goalSatisfied:goal.every((f)=>item.facts.has(f))
  };
}
function scoreFrontier(item:Frontier,goal:string[]):number{
  const coverage=goal.filter((f)=>item.facts.has(f)).length/goal.length;
  return coverage*.5+item.success*.2+(1-item.infoComplement)*.08+
    (item.operatorIds.length?item.verificationTotal/item.operatorIds.length:0)*.1-
    (1-item.riskComplement)*.1-Math.min(1,item.cost/100)*.02;
}
function branchUtility(c:PlanBranchCandidate):number{
  return c.expectedSuccess*.45+c.verificationStrength*.16+c.expectedInformationGain*.1+c.reversibleFraction*.07-c.risk*.16-c.uncertainty*.08-Math.min(1,c.expectedCost/100)*.04;
}
function normalizeOperator(input:PlanningOperator):PlanningOperator{
  if(!input||typeof input!=='object') throw new Error('planning operator is required.');
  return {
    id:bounded(input.id,256,'operator.id'),
    requires:unique(input.requires.map((v)=>bounded(v,512,'operator.requires'))),
    adds:unique(input.adds.map((v)=>bounded(v,512,'operator.adds'))),
    removes:unique(input.removes.map((v)=>bounded(v,512,'operator.removes'))),
    expectedSuccess:unit(input.expectedSuccess,'operator.expectedSuccess'),
    expectedInformationGain:unit(input.expectedInformationGain,'operator.expectedInformationGain'),
    expectedCost:finite(input.expectedCost,0,1e12,'operator.expectedCost'),
    risk:unit(input.risk,'operator.risk'),
    verificationStrength:unit(input.verificationStrength,'operator.verificationStrength'),
    reversible:Boolean(input.reversible)
  };
}
function stateSignature(facts:Set<string>):string{return [...facts].sort().join('\u001f');}
function unique(v:string[]):string[]{return [...new Set(v)].sort();}
function bounded(v:unknown,m:number,l:string):string{if(typeof v!=='string'||!v||v.length>m)throw new Error(l+' is invalid.');return v;}
function finite(v:unknown,min:number,max:number,l:string):number{if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max)throw new Error(l+' is invalid.');return v;}
function unit(v:unknown,l:string):number{return finite(v,0,1,l);}
function integer(v:unknown,min:number,max:number,l:string):number{if(typeof v!=='number'||!Number.isSafeInteger(v)||v<min||v>max)throw new Error(l+' is invalid.');return v;}
function round(v:number):number{return Math.round(v*1e6)/1e6;}
