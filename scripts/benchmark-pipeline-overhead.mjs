/** Standalone matched-pair in-process tracing overhead probe (no network/Chrome/audit writes). */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { PipelineLatencyRecorder } from '../src/core/pipeline-latency.ts';

const batches = 30;
const perBatch = 1000;
const untraced = new PipelineLatencyRecorder({enabled:false});
const traced = new PipelineLatencyRecorder({enabled:true,capacity:8192});
const options={stage:'browser.operation',origin:'benchmark',traceId:'synthetic-matched-operation'};
const simple=async()=>1;
async function measure(recorder) {
 const start=performance.now();
 for(let n=0;n<perBatch;n++)assert.equal(await recorder.measure(options,simple),1);
 return performance.now()-start;
}
const disabled=[],enabled=[];
await measure(untraced);await measure(traced);
for(let i=0;i<batches;i++){
 if(i%2===0){disabled.push(await measure(untraced));enabled.push(await measure(traced));}
 else {enabled.push(await measure(traced));disabled.push(await measure(untraced));}
}
const summarize=(xs)=>{
 const ordered=xs.slice().sort((a,b)=>a-b);
 return {count:xs.length,minMs:ordered[0],maxMs:ordered.at(-1),
  meanMs:xs.reduce((a,b)=>a+b,0)/xs.length,
  p50Ms:ordered[Math.ceil(xs.length*.5)-1],
  p95Ms:ordered[Math.ceil(xs.length*.95)-1],
  p99Ms:ordered[Math.ceil(xs.length*.99)-1]};
};
const overhead=enabled.map((ms,i)=>ms-disabled[i]);
const sha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const metadata={sourceSha:sha,runtimeVersion:process.version,os:os.type()+' '+os.release(),
 machine:'Sampath-isolated-synthetic',batches,operationsPerBatch:perBatch,
 tracingEnabledFlag:'explicit per recorder',workload:'in-process async no-op only, NOT hosted or browser'};
const result={schemaVersion:1,capturedAt:new Date().toISOString(),metadata,
 baselineDisabled:summarize(disabled),tracedEnabled:summarize(enabled),
 pairedOverheadPerBatch:summarize(overhead),
 pairedOverheadPerOperationMs:summarize(overhead.map(ms=>ms/perBatch)),
 totalOperationsPerMode:batches*perBatch,
 warnings:['Single-machine microbenchmark: OS scheduling, JIT and GC can affect percentiles.',
  'Does not measure production network, disk audit writes, Chrome, hosted or model overhead.',
  'Negative per-batch deltas are retained without clipping.']};
assert.equal(traced.droppedSpans,(batches+1)*perBatch-traced.capacity);
const output=path.resolve('artifacts','pipeline-overhead-'+new Date().toISOString().replace(/[:.]/g,'-'));
await fs.mkdir(output,{recursive:true});
await fs.writeFile(path.join(output,'overhead.json'),JSON.stringify(result,null,2)+'\n');
const lines=['# Matched-pair tracing overhead (synthetic, local only)','',
 'Source SHA: '+sha,'Node: '+process.version,'OS: '+metadata.os,
 'Workload: '+batches+' alternate-order batches Ã— '+perBatch+' async no-op operations each, per mode.','',
 '| Mode | p50 batch ms | p95 batch ms | p99 batch ms |',
 '|---|---:|---:|---:|',
 '| Disabled | '+[result.baselineDisabled.p50Ms,result.baselineDisabled.p95Ms,result.baselineDisabled.p99Ms].map(n=>n.toFixed(3)).join(' | ')+' |',
 '| Enabled | '+[result.tracedEnabled.p50Ms,result.tracedEnabled.p95Ms,result.tracedEnabled.p99Ms].map(n=>n.toFixed(3)).join(' | ')+' |',
 '| Paired difference | '+[result.pairedOverheadPerBatch.p50Ms,result.pairedOverheadPerBatch.p95Ms,result.pairedOverheadPerBatch.p99Ms].map(n=>n.toFixed(3)).join(' | ')+' |',
 '',...result.warnings.map(s=>'- '+s),''];
await fs.writeFile(path.join(output,'overhead.md'),lines.join('\n'));
console.log('MECORD_PIPELINE_OVERHEAD_REPORT_DIR='+output);
console.log('MECORD_PIPELINE_OVERHEAD_P50_US_PER_OPERATION='+(result.pairedOverheadPerOperationMs.p50Ms*1000).toFixed(3));
