import crypto from 'node:crypto';
import { canonicalJson } from './action-identity.ts';
import { twinSupportsClaim, type TwinFidelityDimension } from './counterfactual-twin.ts';
import type { ReconstructedCounterfactualTwin } from './counterfactual-twin-runtime.ts';
import { OperatorError } from './errors.ts';

export interface CounterfactualPlanStep {
  id:string;
  resourceKey:string;
  beforeDigest?:string;
  afterDigest:string;
  effect:'read'|'create'|'update'|'delete'|'external';
  reversible:boolean;
  testIds?:string[];
}

export interface CounterfactualPlanCandidate {
  id:string;
  requiredDimensions:TwinFidelityDimension['dimension'][];
  steps:CounterfactualPlanStep[];
}

export interface CounterfactualPlanEvaluation {
  planId:string;
  eligible:boolean;
  score:number;
  blastRadius:number;
  conflicts:string[];
  tests:string[];
  irreversibleEffects:number;
  predictedStateDigest:string;
  predictedResources:Record<string,string>;
}

export function evaluateCounterfactualPlan(
  twin:ReconstructedCounterfactualTwin,
  candidateInput:CounterfactualPlanCandidate
):CounterfactualPlanEvaluation{
  const candidate=normalizeCandidate(candidateInput);
  const support=twinSupportsClaim(twin.manifest,candidate.requiredDimensions);
  const resources:{[key:string]:string}={...twin.virtualResources};
  const conflicts:string[]=[];
  const tests=new Set<string>();
  const touched=new Set<string>();
  let irreversibleEffects=0;

  if(!support.supported){
    for(const dimension of support.missing)conflicts.push('Twin dimension '+dimension+' is absent.');
    for(const dimension of support.partial)conflicts.push('Twin dimension '+dimension+' is only partial.');
  }

  for(const step of candidate.steps){
    const current=resources[step.resourceKey];
    if(step.beforeDigest!==undefined&&current!==step.beforeDigest){
      conflicts.push('Step '+step.id+' precondition does not match resource '+step.resourceKey+'.');
      continue;
    }
    if(step.effect==='create'&&current!==undefined){
      conflicts.push('Step '+step.id+' cannot create an existing resource '+step.resourceKey+'.');
      continue;
    }
    if((step.effect==='update'||step.effect==='delete')&&current===undefined){
      conflicts.push('Step '+step.id+' requires an existing resource '+step.resourceKey+'.');
      continue;
    }
    touched.add(step.resourceKey);
    for(const testId of step.testIds??[])tests.add(testId);
    if(!step.reversible&&step.effect!=='read')irreversibleEffects+=1;
    if(step.effect==='delete')delete resources[step.resourceKey];
    else if(step.effect!=='read')resources[step.resourceKey]=step.afterDigest;
  }

  const predictedResources=Object.fromEntries(Object.entries(resources).sort(([a],[b])=>a.localeCompare(b)));
  const predictedStateDigest=crypto.createHash('sha256').update(canonicalJson(predictedResources),'utf8').digest('hex');
  const blastRadius=touched.size;
  const eligible=conflicts.length===0;
  const score=eligible
    ? Math.round((1000-(blastRadius*25)-(irreversibleEffects*100)+(tests.size*10))*1000)/1000
    : -1_000_000;
  return{
    planId:candidate.id,
    eligible,
    score,
    blastRadius,
    conflicts,
    tests:[...tests].sort(),
    irreversibleEffects,
    predictedStateDigest,
    predictedResources
  };
}

export function compareCounterfactualPlans(
  twin:ReconstructedCounterfactualTwin,
  candidates:CounterfactualPlanCandidate[]
):CounterfactualPlanEvaluation[]{
  if(!Array.isArray(candidates)||candidates.length<1||candidates.length>1000)throw invalid('Plan candidates are invalid.');
  return candidates.map((candidate)=>evaluateCounterfactualPlan(twin,candidate))
    .sort((a,b)=>Number(b.eligible)-Number(a.eligible)||b.score-a.score||a.planId.localeCompare(b.planId));
}

function normalizeCandidate(input:CounterfactualPlanCandidate):CounterfactualPlanCandidate{
  if(!input||typeof input!=='object'||!Array.isArray(input.steps)||input.steps.length<1||input.steps.length>10_000)throw invalid('Plan candidate is invalid.');
  const requiredDimensions=[...new Set(input.requiredDimensions??[])];
  const validDimensions=new Set(['repository','dependencies','environment','services','database','browser','policy','world-state']);
  if(requiredDimensions.some((dimension)=>!validDimensions.has(dimension)))throw invalid('Plan required dimensions are invalid.');
  const ids=new Set<string>();
  const steps=input.steps.map((step)=>{
    const id=boundedId(step.id,'step id');
    if(ids.has(id))throw invalid('Plan step IDs must be unique.');ids.add(id);
    if(!['read','create','update','delete','external'].includes(step.effect))throw invalid('Plan step effect is invalid.');
    return{
      id,
      resourceKey:resourceKey(step.resourceKey),
      ...(step.beforeDigest!==undefined?{beforeDigest:digest(step.beforeDigest,'beforeDigest')}:{ }),
      afterDigest:digest(step.afterDigest,'afterDigest'),
      effect:step.effect,
      reversible:step.reversible===true,
      ...(step.testIds?{testIds:list(step.testIds,1000,'testIds')}:{})
    };
  });
  return{id:boundedId(input.id,'plan id'),requiredDimensions:requiredDimensions as TwinFidelityDimension['dimension'][],steps};
}

function boundedId(v:unknown,label:string):string{const s=String(v??'');if(!/^[A-Za-z0-9._:@/+\-=]{1,256}$/.test(s))throw invalid(label+' is invalid.');return s;}
function resourceKey(v:unknown):string{const s=String(v??'');if(!s||s.length>4096||s.includes('\0'))throw invalid('resourceKey is invalid.');return s;}
function digest(v:unknown,label:string):string{const s=String(v??'').toLowerCase();if(!/^[0-9a-f]{64}$/.test(s))throw invalid(label+' is invalid.');return s;}
function list(v:unknown,max:number,label:string):string[]{if(!Array.isArray(v)||v.length>max)throw invalid(label+' is invalid.');return[...new Set(v.map((x)=>boundedId(x,label)))].sort();}
function invalid(m:string):OperatorError{return new OperatorError('COUNTERFACTUAL_PLAN_INVALID',m);}
