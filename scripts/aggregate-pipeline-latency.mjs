/** Offline aggregation of explicitly supplied bounded host snapshots. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { PIPELINE_STAGES, summarizePipelineSpans, pipelineReportMarkdown } from '../src/core/pipeline-latency.ts';

const inputs=process.argv.slice(2);
if(inputs.length<1||inputs.length>12)throw new Error('Provide 1..12 authorized pipeline snapshot JSON paths.');
const origins=new Set(['hosted-mcp','relay-server','local-agent','browser','benchmark']);
const stages=new Set(PIPELINE_STAGES);
const observed=[],sources=[];
let dropped=0;
const safeLabel=(value)=>String(value??'unverified').replace(/[\r\n|<>]/g,' ').slice(0,160);
const safeInt=(v)=>Number.isSafeInteger(v)&&v>=0&&v<1e9?v:undefined;
function project(source){
 if(!source||typeof source!=='object'||Array.isArray(source))return null;
 const {traceId,spanId,stage,origin,result,startTime,durationMs,parentSpanId}=source;
 if(typeof traceId!=='string'||!/^[0-9a-f]{64}$/.test(traceId)
   ||typeof spanId!=='string'||spanId.length>128
   ||!stages.has(stage)||!origins.has(origin)
   ||!['ok','failed','timeout','cancelled'].includes(result)
   ||typeof startTime!=='string'||!Number.isFinite(Date.parse(startTime))
   ||typeof durationMs!=='number'||!Number.isFinite(durationMs)||durationMs<0||durationMs>86400000)return null;
 const s={traceId,spanId,stage,origin,result,startTime:new Date(startTime).toISOString(),durationMs};
 if(typeof parentSpanId==='string'&&parentSpanId.length<=128)s.parentSpanId=parentSpanId;
 for(const field of ['payloadBytes','networkRoundTrips','retries','reconnects']){
  const value=safeInt(source[field]);if(value!==undefined)s[field]=value;
 }
 if(typeof source.warm==='boolean')s.warm=source.warm;
 return s;
}
for(const filename of inputs){
 const file=path.resolve(filename),info=await fs.stat(file);
 if(info.size>8*1024*1024||info.size===0)throw new Error('Snapshot must be between 1 byte and 8MiB.');
 const raw=JSON.parse(await fs.readFile(file,'utf8'));
 if(raw?.schemaVersion!==1||!Array.isArray(raw.spans)||raw.spans.length>8192
   ||!raw.metadata||typeof raw.metadata!=='object')throw new Error('Invalid bounded pipeline snapshot schema.');
 const projected=raw.spans.map(project);
 if(projected.some(x=>x===null))throw new Error('Snapshot contains an invalid span.');
 observed.push(...projected);
 dropped+=safeInt(raw.droppedSpans)??0;
 sources.push({sourceSha:safeLabel(raw.metadata.sourceSha),runtimeVersion:safeLabel(raw.metadata.runtimeVersion),
  operatingSystem:safeLabel(raw.metadata.operatingSystem),
  chromeVersion:safeLabel(raw.metadata.chromeVersion),
  machine:safeLabel(raw.metadata.machine),capturedAt:safeLabel(raw.capturedAt),count:projected.length});
}
const shas=[...new Set(sources.map(s=>s.sourceSha))];
const meta={sourceSha:shas.join(',').slice(0,180),
 runtimeVersion:[...new Set(sources.map(s=>s.runtimeVersion))].join(',').slice(0,180),
 operatingSystem:'multiple recorded hosts',chromeVersion:[...new Set(sources.map(s=>s.chromeVersion))].join(',').slice(0,180),
 machine:sources.map(s=>s.machine).join(',').slice(0,180),
 conditions:'offline aggregation; origin-local monotonic durations only'};
const summary=summarizePipelineSpans(observed,meta,dropped);
const grouped=new Map();
for(const s of observed){const e=grouped.get(s.traceId)??[];e.push(s);grouped.set(s.traceId,e);}
const correlated=[];
for(const [traceId,spans] of grouped){
 const outer=spans.filter(s=>s.stage==='hosted.relay_roundtrip');
 const local=spans.filter(s=>s.stage==='local.request_processing');
 correlated.push({traceId,originNames:[...new Set(spans.map(s=>s.origin))].sort(),
  spanCount:spans.length,hostedRelayRoundtripMs:outer.length===1?outer[0].durationMs:null,
  localHandlingMs:local.length===1?local[0].durationMs:null,
  fullPipelineVerified:false,unobservableGapMs:null,
  incomplete:spans.some(s=>s.result!=='ok'),
  explanation:'Cross-host offsets, nesting and unobserved edges prevent exact reconciliation.'});
}
const output=path.resolve(process.env.OPERATOR_PIPELINE_AGGREGATE_DIR || path.join('artifacts','pipeline-aggregate-'+new Date().toISOString().replace(/[:.]/g,'-')));
await fs.mkdir(output,{recursive:true});
const result={schemaVersion:1,generatedAt:new Date().toISOString(),sources,
 sourceShaMatch:shas.length===1,traceCount:grouped.size,retainedSpans:observed.length,droppedSpans:dropped,
 aggregateStageReport:summary,correlatedTraces:correlated.slice(0,1000),
 limitations:['ChatGPT model/tool wall time is unobservable in local runtime.',
 'Cross-host epoch timestamps are display-only; never subtracted.',
 'Full reconciliation requires source-matched hosted and local boundary evidence.']};
await fs.writeFile(path.join(output,'merged.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600});
const md=[pipelineReportMarkdown(summary),'## Correlation','',
 'Traces: '+grouped.size+'; sources: '+sources.length+'; same SHA: '+(shas.length===1)+'.',
 'Unobservable per-trace gaps remain null without verified boundary evidence.','',
 '| OS | SHA | Spans | Machine |','|---|---|---:|---|',
 ...sources.map(s=>'| '+s.operatingSystem+' | '+s.sourceSha+' | '+s.count+' | '+s.machine+' |'),
 '',...result.limitations.map(s=>'- '+s),''];
await fs.writeFile(path.join(output,'merged.md'),md.join('\n'),{mode:0o600});
console.log('PIPELINE_AGGREGATE_DIR='+output);
console.log('PIPELINE_AGGREGATE_TRACE_COUNT='+grouped.size);
console.log('PIPELINE_AGGREGATE_DROPPED='+dropped);
