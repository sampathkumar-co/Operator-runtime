import type { DecisionTraceRecord } from './decision-trace.ts';

export interface DecisionOutcomeVerificationReceiptRef {
  digest:string;
  runId:string;
  goalId:string;
  verifierId:string;
  verifiedAt:string;
  authoritySnapshotDigest:string;
  outcome:'success'|'failure';
}

export interface DecisionOutcome {
  runId:string;
  taskId:string;
  goalId:string;
  decisionDigest:string;
  verificationReceipt:DecisionOutcomeVerificationReceiptRef;
  progressScore?:number;
  cost?:number;
}

export interface ShadowComparisonReport {
  pairedDecisions:number;
  pairedOutcomeDecisions:number;
  outcomeCoverage:number;
  progressCoverage:number;
  costCoverage:number;
  agreementRate:number;
  divergenceRate:number;
  shadowWinRate:number;
  controlWinRate:number;
  tiedOutcomeRate:number;
  meanShadowProgressDelta:number;
  meanShadowCostDelta:number;
  unmatchedShadow:number;
  unmatchedControl:number;
}

export function compareShadowToControl(
  tracesInput:DecisionTraceRecord[],
  outcomesInput:DecisionOutcome[],
  options:{now?:Date}={}
):ShadowComparisonReport{
  if(!Array.isArray(tracesInput)||tracesInput.length>1_000_000) throw new Error('decision traces are invalid.');
  if(!Array.isArray(outcomesInput)||outcomesInput.length>1_000_000) throw new Error('decision outcomes are invalid.');
  const now=options.now??new Date();
  if(!Number.isFinite(now.getTime())) throw new Error('shadow comparison time is invalid.');

  const traces=tracesInput.filter((trace)=>trace.kind==='STRATEGY'||trace.kind==='RECOVERY'||trace.kind==='OBSERVATION');
  assertSingleRunCohort(traces);
  assertSinglePolicyCohort(traces.filter((trace)=>trace.mode==='SHADOW'),'shadow');
  assertSinglePolicyCohort(traces.filter((trace)=>trace.mode==='CONTROL'),'control');

  const outcomes=new Map<string,DecisionOutcome>();
  for(const raw of outcomesInput){
    const outcome=normalizeOutcome(raw,now);
    if(outcomes.has(outcome.decisionDigest)) throw new Error('Duplicate decision outcome digest is rejected.');
    outcomes.set(outcome.decisionDigest,outcome);
  }
  const shadow=group(traces.filter((trace)=>trace.mode==='SHADOW'));
  const control=group(traces.filter((trace)=>trace.mode==='CONTROL'));

  let paired=0,outcomePairs=0,agreements=0,shadowWins=0,controlWins=0,ties=0;
  let progressDelta=0,costDelta=0,progressPairs=0,costPairs=0;
  const matchedShadow=new Set<string>(),matchedControl=new Set<string>();

  for(const [key,shadowList] of shadow){
    const controlList=control.get(key);
    if(!controlList?.length) continue;
    if(key.includes('|state:')&&(shadowList.length>1||controlList.length>1)){
      throw new Error('Ambiguous shadow/control fallback pairing requires explicit decisionPointId values.');
    }
    const count=Math.min(shadowList.length,controlList.length);
    for(let i=0;i<count;i+=1){
      const s=shadowList[i]!,c=controlList[i]!;
      paired+=1;
      matchedShadow.add(s.decisionDigest);
      matchedControl.add(c.decisionDigest);
      if((s.selectedId??'')===(c.selectedId??'')) agreements+=1;
      const so=outcomes.get(s.decisionDigest),co=outcomes.get(c.decisionDigest);
      if(so&&co){
        validateOutcomeBinding(so,s,now);
        validateOutcomeBinding(co,c,now);
        outcomePairs+=1;
        const shadowSuccess=so.verificationReceipt.outcome==='success';
        const controlSuccess=co.verificationReceipt.outcome==='success';
        if(shadowSuccess&&!controlSuccess) shadowWins+=1;
        else if(!shadowSuccess&&controlSuccess) controlWins+=1;
        else ties+=1;
        if(so.progressScore!==undefined&&co.progressScore!==undefined){
          progressDelta+=so.progressScore-co.progressScore; progressPairs+=1;
        }
        if(so.cost!==undefined&&co.cost!==undefined){
          costDelta+=so.cost-co.cost; costPairs+=1;
        }
      }
    }
  }

  return {
    pairedDecisions:paired,
    pairedOutcomeDecisions:outcomePairs,
    outcomeCoverage:ratio(outcomePairs,paired),
    progressCoverage:ratio(progressPairs,paired),
    costCoverage:ratio(costPairs,paired),
    agreementRate:ratio(agreements,paired),
    divergenceRate:ratio(paired-agreements,paired),
    shadowWinRate:ratio(shadowWins,outcomePairs),
    controlWinRate:ratio(controlWins,outcomePairs),
    tiedOutcomeRate:ratio(ties,outcomePairs),
    meanShadowProgressDelta:round(progressDelta/Math.max(1,progressPairs)),
    meanShadowCostDelta:round(costDelta/Math.max(1,costPairs)),
    unmatchedShadow:traces.filter(t=>t.mode==='SHADOW'&&!matchedShadow.has(t.decisionDigest)).length,
    unmatchedControl:traces.filter(t=>t.mode==='CONTROL'&&!matchedControl.has(t.decisionDigest)).length
  };
}

function group(traces:DecisionTraceRecord[]):Map<string,DecisionTraceRecord[]>{
  const map=new Map<string,DecisionTraceRecord[]>();
  for(const trace of traces){
    const decisionPoint=trace.decisionPointId
      ? 'point:'+trace.decisionPointId
      : 'state:'+trace.inputStateDigest+'|'+trace.authoritySnapshotDigest;
    const key=trace.runId+'|'+trace.taskId+'|'+trace.goalId+'|'+trace.kind+'|'+decisionPoint;
    const list=map.get(key)??[];
    list.push(trace);
    list.sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.decisionDigest.localeCompare(b.decisionDigest));
    map.set(key,list);
  }
  return map;
}

function assertSingleRunCohort(traces:DecisionTraceRecord[]):void{
  const runs=new Set(traces.map((trace)=>trace.runId));
  if(runs.size>1) throw new Error('Mixed evaluation run ids cannot be combined in one shadow comparison.');
}

function assertSinglePolicyCohort(traces:DecisionTraceRecord[],label:string):void{
  const versions=new Set(traces.map((trace)=>trace.policyVersion));
  if(versions.size>1) throw new Error('Mixed '+label+' policy versions cannot be combined in one shadow comparison.');
}

function validateOutcomeBinding(outcome:DecisionOutcome,trace:DecisionTraceRecord,now:Date):void{
  if(outcome.runId!==trace.runId) throw new Error('Decision outcome run id does not match its trace.');
  if(outcome.taskId!==trace.taskId) throw new Error('Decision outcome task id does not match its trace.');
  if(outcome.goalId!==trace.goalId) throw new Error('Decision outcome goal id does not match its trace.');
  if(outcome.decisionDigest!==trace.decisionDigest) throw new Error('Decision outcome digest does not match its trace.');
  if(outcome.verificationReceipt.runId!==trace.runId) throw new Error('Decision verification receipt run id does not match its trace.');
  if(outcome.verificationReceipt.goalId!==trace.goalId) throw new Error('Decision verification receipt goal id does not match its trace.');
  if(outcome.verificationReceipt.authoritySnapshotDigest!==trace.authoritySnapshotDigest){
    throw new Error('Decision outcome authority snapshot does not match its trace.');
  }
  const verifiedAt=Date.parse(outcome.verificationReceipt.verifiedAt);
  const createdAt=Date.parse(trace.createdAt);
  if(verifiedAt<createdAt) throw new Error('Decision outcome verification cannot predate its decision trace.');
  if(verifiedAt>now.getTime()) throw new Error('Decision outcome verification cannot be future-dated.');
}

function normalizeOutcome(input:DecisionOutcome,now:Date):DecisionOutcome{
  if(!input||typeof input!=='object') throw new Error('decision outcome is required.');
  const runId=bounded(input.runId,512,'decision outcome runId');
  const taskId=bounded(input.taskId,512,'decision outcome taskId');
  const goalId=bounded(input.goalId,256,'decision outcome goalId');
  const decisionDigest=sha256(input.decisionDigest,'decisionDigest');
  if(!input.verificationReceipt||typeof input.verificationReceipt!=='object'){
    throw new Error('Authoritative decision outcome verification receipt is required.');
  }
  const receipt:DecisionOutcomeVerificationReceiptRef={
    digest:sha256(input.verificationReceipt.digest,'verificationReceipt.digest'),
    runId:bounded(input.verificationReceipt.runId,512,'verificationReceipt.runId'),
    goalId:bounded(input.verificationReceipt.goalId,256,'verificationReceipt.goalId'),
    verifierId:bounded(input.verificationReceipt.verifierId,512,'verificationReceipt.verifierId'),
    verifiedAt:validIso(input.verificationReceipt.verifiedAt,'verificationReceipt.verifiedAt'),
    authoritySnapshotDigest:sha256(input.verificationReceipt.authoritySnapshotDigest,'verificationReceipt.authoritySnapshotDigest'),
    outcome:outcomeValue(input.verificationReceipt.outcome)
  };
  if(Date.parse(receipt.verifiedAt)>now.getTime()) throw new Error('Decision outcome verification cannot be future-dated.');
  const normalized:DecisionOutcome={runId,taskId,goalId,decisionDigest,verificationReceipt:receipt};
  if(input.progressScore!==undefined){
    const value=Number(input.progressScore);
    if(!Number.isFinite(value)||value<0||value>1) throw new Error('progressScore must be between 0 and 1.');
    normalized.progressScore=value;
  }
  if(input.cost!==undefined){
    const value=Number(input.cost); if(!Number.isFinite(value)||value<0) throw new Error('cost is invalid.'); normalized.cost=value;
  }
  return normalized;
}

function outcomeValue(input:unknown):'success'|'failure'{
  if(input!=='success'&&input!=='failure') throw new Error('verificationReceipt.outcome is invalid.');
  return input;
}
function bounded(input:unknown,max:number,label:string):string{
  const value=String(input??'');
  if(!value||value.length>max) throw new Error(label+' is invalid.');
  return value;
}
function sha256(input:unknown,label:string):string{
  const value=String(input??'').toLowerCase();
  if(!/^[0-9a-f]{64}$/.test(value)) throw new Error(label+' must be SHA-256.');
  return value;
}
function validIso(input:unknown,label:string):string{
  const value=String(input??'');
  const parsed=Date.parse(value);
  if(!Number.isFinite(parsed)||new Date(parsed).toISOString()!==value) throw new Error(label+' must be ISO timestamp.');
  return value;
}
function ratio(n:number,d:number):number{return d===0?0:round(n/d);}
function round(value:number):number{return Math.round(value*1_000_000)/1_000_000;}
