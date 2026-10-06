import type { DeveloperSession } from './developer-session.ts';
import type { EvidencePack } from './evidence-pack.ts';
import { summarizeOperationSlo, type OperationTraceEvent } from './operation-trace.ts';

export interface AutonomousObjectiveCertification {
  schemaVersion:1;
  sessionId:string;
  status:'CERTIFIED'|'NOT_CERTIFIED';
  reasons:string[];
  evidencePackId?:string;
}

export function certifyAutonomousObjective(input:{
  session:DeveloperSession;
  evidencePack?:EvidencePack;
  traceEvents:OperationTraceEvent[];
  requiredClaimIds?:string[];
}):AutonomousObjectiveCertification{
 const reasons:string[]=[];
 if(input.session.status!=='COMPLETED')reasons.push(`Developer Session is ${input.session.status}, not COMPLETED.`);
 const pack=input.evidencePack;
 if(!pack)reasons.push('No Evidence Pack is attached.');
 if(pack){
  const required=new Set(input.requiredClaimIds??[]);
  const byId=new Map(pack.claims.map(c=>[c.id,c]));
  for(const id of required){
    const claim=byId.get(id);
    if(!claim)reasons.push(`Required claim ${id} is missing.`);
    else if(['UNKNOWN','INFERRED','CONTRADICTED'].includes(claim.level))reasons.push(`Required claim ${id} has insufficient proof level ${claim.level}.`);
  }
  if(pack.claims.some(c=>c.level==='CONTRADICTED'))reasons.push('Evidence Pack contains a contradicted claim.');
  if(pack.rollbackStatus==='FAILED')reasons.push('Rollback status is FAILED.');
 }
 const slo=summarizeOperationSlo(input.traceEvents);
 if(slo.traces<1)reasons.push('No causal operation trace is available.');
 if(slo.falseCompletionCount>0)reasons.push('Operation traces contain completion without independent verification.');
 if(slo.uncertain>0)reasons.push('Operation traces contain unresolved uncertain outcomes.');
 return{
  schemaVersion:1,
  sessionId:input.session.id,
  status:reasons.length===0?'CERTIFIED':'NOT_CERTIFIED',
  reasons,
  ...(pack?{evidencePackId:pack.id}:{})
 };
}
