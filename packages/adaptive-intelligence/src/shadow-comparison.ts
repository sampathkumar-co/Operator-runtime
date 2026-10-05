import type { DecisionTraceRecord } from './decision-trace.ts';

export interface DecisionOutcome {
  taskId:string;
  decisionDigest:string;
  verifiedSuccess:boolean;
  progressScore?:number;
  cost?:number;
}

export interface ShadowComparisonReport {
  pairedDecisions:number;
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
  outcomesInput:DecisionOutcome[]
):ShadowComparisonReport{
  if(!Array.isArray(tracesInput)||tracesInput.length>1_000_000) throw new Error('decision traces are invalid.');
  if(!Array.isArray(outcomesInput)||outcomesInput.length>1_000_000) throw new Error('decision outcomes are invalid.');
  const traces=tracesInput.filter((trace)=>trace.kind==='STRATEGY'||trace.kind==='RECOVERY'||trace.kind==='OBSERVATION');
  const outcomes=new Map(outcomesInput.map((outcome)=>[outcome.decisionDigest,normalizeOutcome(outcome)]));
  const shadow=group(traces.filter((trace)=>trace.mode==='SHADOW'));
  const control=group(traces.filter((trace)=>trace.mode==='CONTROL'));

  let paired=0,agreements=0,shadowWins=0,controlWins=0,ties=0;
  let progressDelta=0,costDelta=0,progressPairs=0,costPairs=0;
  const matchedShadow=new Set<string>(),matchedControl=new Set<string>();

  for(const [key,shadowList] of shadow){
    const controlList=control.get(key);
    if(!controlList?.length) continue;
    const count=Math.min(shadowList.length,controlList.length);
    for(let i=0;i<count;i+=1){
      const s=shadowList[i]!,c=controlList[i]!;
      paired+=1;
      matchedShadow.add(s.decisionDigest);
      matchedControl.add(c.decisionDigest);
      if((s.selectedId??'')===(c.selectedId??'')) agreements+=1;
      const so=outcomes.get(s.decisionDigest),co=outcomes.get(c.decisionDigest);
      if(so&&co){
        if(so.verifiedSuccess&&!co.verifiedSuccess) shadowWins+=1;
        else if(!so.verifiedSuccess&&co.verifiedSuccess) controlWins+=1;
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
    agreementRate:ratio(agreements,paired),
    divergenceRate:ratio(paired-agreements,paired),
    shadowWinRate:ratio(shadowWins,shadowWins+controlWins+ties),
    controlWinRate:ratio(controlWins,shadowWins+controlWins+ties),
    tiedOutcomeRate:ratio(ties,shadowWins+controlWins+ties),
    meanShadowProgressDelta:round(progressDelta/Math.max(1,progressPairs)),
    meanShadowCostDelta:round(costDelta/Math.max(1,costPairs)),
    unmatchedShadow:traces.filter(t=>t.mode==='SHADOW'&&!matchedShadow.has(t.decisionDigest)).length,
    unmatchedControl:traces.filter(t=>t.mode==='CONTROL'&&!matchedControl.has(t.decisionDigest)).length
  };
}

function group(traces:DecisionTraceRecord[]):Map<string,DecisionTraceRecord[]>{
  const map=new Map<string,DecisionTraceRecord[]>();
  for(const trace of traces){
    const key=trace.taskId+'|'+trace.kind+'|'+trace.inputStateDigest+'|'+trace.authoritySnapshotDigest;
    const list=map.get(key)??[];
    list.push(trace);
    list.sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.decisionDigest.localeCompare(b.decisionDigest));
    map.set(key,list);
  }
  return map;
}
function normalizeOutcome(input:DecisionOutcome):DecisionOutcome{
  if(!input||typeof input!=='object') throw new Error('decision outcome is required.');
  if(!/^[0-9a-f]{64}$/.test(input.decisionDigest)) throw new Error('decisionDigest is invalid.');
  const normalized:DecisionOutcome={taskId:String(input.taskId),decisionDigest:input.decisionDigest,verifiedSuccess:Boolean(input.verifiedSuccess)};
  if(input.progressScore!==undefined){
    const value=Number(input.progressScore); if(!Number.isFinite(value)) throw new Error('progressScore is invalid.'); normalized.progressScore=value;
  }
  if(input.cost!==undefined){
    const value=Number(input.cost); if(!Number.isFinite(value)||value<0) throw new Error('cost is invalid.'); normalized.cost=value;
  }
  return normalized;
}
function ratio(n:number,d:number):number{return d===0?0:round(n/d);}
function round(value:number):number{return Math.round(value*1_000_000)/1_000_000;}
