import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { PipelineLatencyRecorder, opaqueTraceId, writePipelineSnapshot } from '../src/core/pipeline-latency.ts';

const root=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const meta=(name:string)=>({sourceSha:'synthetic-same-sha',runtimeVersion:'synthetic-test',
 operatingSystem:process.platform,chromeVersion:'not-available',machine:name,
 conditions:'synthetic mocked asynchronous operations only'});
async function tmp(t:test.TestContext) {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mecord-pipeline-export-'));
 t.after(async()=>await fs.rm(dir,{recursive:true,force:true}));
 return dir;
}
test('snapshot export is bounded, private, atomic and replaces exactly one file',async t=>{
 const dir=await tmp(t);
 const rec=new PipelineLatencyRecorder({enabled:true,capacity:4});
 const destination=path.join(dir,'snapshot.json');
 await rec.measure({traceId:'sensitive-user-and-task',origin:'local-agent',
  stage:'local.authorization_approval',payloadBytes:42},async()=>1);
 rec.record({traceId:opaqueTraceId('sensitive-user-and-task'),spanId:'leak-Bearer-secret',
  stage:'browser.operation',origin:'browser',startTime:new Date().toISOString(),
  durationMs:1,result:'ok'} as any);
 const result=await writePipelineSnapshot(destination,meta('synthetic-node'),rec);
 assert.equal(result.spans,1);
 const raw=await fs.readFile(destination,'utf8');
 assert.equal(JSON.parse(raw).spans.length,1);
 assert.doesNotMatch(raw,/sensitive-user-and-task|leak-Bearer-secret|password|authorizationHeader/);
 await rec.measure({traceId:'sensitive-user-and-task',origin:'local-agent',
  stage:'local.resource_lease'},async()=>1);
 await writePipelineSnapshot(destination,meta('synthetic-node'),rec);
 assert.equal((await fs.readdir(dir)).length,1,'snapshot overwrites one bounded file, no append/temporary leftovers');
 assert.equal(JSON.parse(await fs.readFile(destination,'utf8')).spans.length,2);
 assert.ok((await fs.stat(destination)).size<10*1024);
});

test('offline multi-source merge correlates task IDs, preserves unknown gaps and strips private fields',async t=>{
 const dir=await tmp(t),output=path.join(dir,'merged');
 const hosted=new PipelineLatencyRecorder({enabled:true});
 const local=new PipelineLatencyRecorder({enabled:true});
 const stable='mcp-request-shared-logical-id';
 await hosted.measure({traceId:stable,origin:'hosted-mcp',stage:'hosted.relay_roundtrip',networkRoundTrips:1},
  async()=>await Promise.resolve());
 await local.measure({traceId:stable,origin:'local-agent',stage:'local.request_processing'},
  async()=>await Promise.resolve());
 const a=path.join(dir,'hosted.json'),b=path.join(dir,'local.json');
 await writePipelineSnapshot(a,meta('hosted-A'),hosted);
 await writePipelineSnapshot(b,meta('device-B'),local);
 const script=path.join(root,'scripts','aggregate-pipeline-latency.mjs');
 const stdout=execFileSync(process.execPath,['--experimental-strip-types',script,a,b],
  {cwd:root,encoding:'utf8',env:{...process.env,OPERATOR_PIPELINE_AGGREGATE_DIR:output},timeout:20_000});
 assert.match(stdout,/PIPELINE_AGGREGATE_TRACE_COUNT=1/);
 assert.match(stdout,/PIPELINE_AGGREGATE_DROPPED=0/);
 const merged=JSON.parse(await fs.readFile(path.join(output,'merged.json'),'utf8'));
 assert.equal(merged.sources.length,2);
 assert.equal(merged.aggregateStageReport.stages.length,2);
 assert.equal(merged.correlatedTraces[0].traceId,opaqueTraceId(stable));
 assert.equal(merged.correlatedTraces[0].unobservableGapMs,null);
 assert.equal(merged.correlatedTraces[0].fullPipelineVerified,false);
 assert.deepEqual(merged.correlatedTraces[0].originNames,['hosted-mcp','local-agent']);
 assert.doesNotMatch(JSON.stringify(merged),/mcp-request-shared-logical-id|authorizationHeader|Bearer secret/);
});

test('aggregator fails closed for missing/corrupt data, rather than inventing latency',async t=>{
 const dir=await tmp(t),file=path.join(dir,'bad.json'),script=path.join(root,'scripts','aggregate-pipeline-latency.mjs');
 await fs.writeFile(file,JSON.stringify({schemaVersion:1,spans:[{traceId:'raw secret'}],metadata:{}}));
 assert.throws(()=>execFileSync(process.execPath,['--experimental-strip-types',script,file],{
  cwd:root,stdio:'pipe',timeout:15_000,env:{...process.env,OPERATOR_PIPELINE_AGGREGATE_DIR:path.join(dir,'output')}
 }),/Command failed/);
});
