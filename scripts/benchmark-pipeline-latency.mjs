import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { BrowserCdpProvider } from '../src/capabilities/browser-cdp.ts';
import { CdpConnection } from '../src/capabilities/browser-cdp-connection.ts';
import { pipelineLatency, pipelineReportMarkdown } from '../src/core/pipeline-latency.ts';
import { execFileSync } from 'node:child_process';

const samples = (values) => {
  const sorted = [...values].sort((a,b) => a-b);
  const quantile = (p) => sorted[Math.max(0,Math.ceil(p*sorted.length)-1)];
  return { count: sorted.length, p50Ms: +quantile(0.5).toFixed(1), p95Ms: +quantile(0.95).toFixed(1),
    maxMs: +sorted.at(-1).toFixed(1), meanMs: +(sorted.reduce((a,b)=>a+b,0)/sorted.length).toFixed(1) };
};
const delay = (ms) => new Promise(resolve=>setTimeout(resolve,ms));
const browserPath = process.env.MECORD_BENCH_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const repetitions = Math.max(30, Math.min(1000, Number(process.env.MECORD_BENCH_REPS || 30)));
const extended = process.env.MECORD_BENCH_SCENARIOS === 'extended';
const backgroundFlags = process.env.MECORD_BENCH_BACKGROUND_FLAGS === '1';
const skipWorkflowFocus = process.env.MECORD_BENCH_SKIP_WORKFLOW_FOCUS === '1';
const focusEmulation = process.env.MECORD_BENCH_FOCUS_EMULATION === '1';
const diagnosticCount = Number(process.env.MECORD_BENCH_DIAGNOSTIC_REPS || repetitions);
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-isolated-browser-benchmark-'));
const page = '<!doctype html><html><head><title>Mecord Synthetic Fixture</title></head><body><h1>Local synthetic benchmark</h1>'
  + Array.from({length:10}, (_,i)=>'<label>Field '+i+'<input id="f'+i+'" type="text" aria-label="Field '+i+'"></label>').join('')
  + '<button id="tap" onclick="document.querySelector(\'#status\').textContent=String(Number(document.querySelector(\'#status\').textContent||0)+1);this.textContent=String(Date.now())">Tap</button><output id="status">0</output></body></html>';
const extendedPage = page.replace('</body></html>', "<button id=\"spa\" onclick=\"this.dataset.steps=String(Number(this.dataset.steps||0)+1);location.hash='#/spa'+this.dataset.steps;document.getElementById('spa-state').textContent=this.dataset.steps\">SPA</button><output id=\"spa-state\">idle</output></body></html>");
const server = http.createServer((req,res)=> {
  res.setHeader('content-type','text/html; charset=utf-8');res.setHeader('cache-control','no-store');res.end(extendedPage);
});
const listen = new Promise((resolve,reject)=>{server.once('error',reject); server.listen(0,'127.0.0.1',resolve);});
await listen;
const fixture = 'http://127.0.0.1:'+server.address().port+'/';
const chrome = spawn(browserPath,['--headless=new','--no-first-run','--no-default-browser-check','--disable-extensions',
  '--disable-background-networking',
  ...(backgroundFlags?['--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows']:[]),
  '--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{
  windowsHide:true,stdio:'ignore'
});
let provider;
let focusEmulationConnection;
const report={sourceCommit:process.env.MECORD_BENCH_SHA||null, platform:process.platform,node:process.version,
  suite:'isolated real-Chrome CDP provider; excludes MCP/relay/model latency',browserPath};
try {
  let port;
  const deadline=Date.now()+15000;
  while(Date.now()<deadline){
    if(chrome.exitCode!==null) throw Error('Isolated Chrome exited before CDP was available.');
    try {
      const file=await fs.readFile(path.join(profile,'DevToolsActivePort'),'utf8');
      port=Number(file.split(/\r?\n/)[0]); if(Number.isInteger(port)&&port>0)break;
    }catch{}
    await delay(100);
  }
  assert.ok(port,'Isolated Chrome CDP launch timed out');
  provider=new BrowserCdpProvider('http://127.0.0.1:'+port);
  let actionIndex=0;
  const call=async(capability,risk,input,allowFailure=false)=>{
    const t=performance.now();
    const result=await provider.execute({id:'synthetic-bench-'+(++actionIndex),capability,risk,input,
      provenance:{kind:'runtime',source:'synthetic-benchmark'}});
    const ms=performance.now()-t;
    if(!result.ok && !allowFailure)throw new Error(capability+' '+(result.error?.code||'UNKNOWN')+': '+(result.error?.message||'unknown'));
    return {result,ms};
  };
  const nav=await call('browser.navigate','external',{url:fixture,newTab:true});
  const targetId=nav.result.output.targetId;
  assert.ok(targetId);
  report.coldNavigationMs=+nav.ms.toFixed(1);
  report.warmTabDiscovery=[];
  report.warmSemanticInspection=[];
  report.warmClick=[];
  report.tenFieldForm=[];
  if (!extended) {
  for(let i=0;i<repetitions;i++){
    const discovery=await call('browser.inspect','read',{});
    report.warmTabDiscovery.push(discovery.ms);
    const inspected=await call('browser.inspect','read',{targetId});
    report.warmSemanticInspection.push(inspected.ms);
    const click=await call('browser.interact','external',{targetId,operation:'click',target:{css:'#tap'}});
    report.warmClick.push(click.ms);
  }
  for(let j=0;j<repetitions;j++){
    const t=performance.now();
    for(let i=0;i<10;i++){
      await call('browser.interact','external',{targetId,operation:'type',target:{css:'#f'+i},
        value:'test-'+j+'-'+i});
    }
    report.tenFieldForm.push(performance.now()-t);
  }
  }
  else {
    report.navigation=[];report.spa=[];report.tabSwitch=[];report.fiveStep=[];
    report.failedRecovery=[];report.coldSessionInspection=[];report.warmSessionInspection=[];
    for(let i=0;i<repetitions;i++){
      const navAgain=await call('browser.navigate','external',{targetId,url:fixture+'?iteration='+i});
      report.navigation.push(navAgain.ms);
    }
    for(let i=0;i<repetitions;i++){
      const changed=await call('browser.interact','external',{targetId,operation:'click',target:{css:'#spa'}});
      report.spa.push(changed.ms);
    }
    const other=await call('browser.navigate','external',{url:fixture+'?tab=two',newTab:true});
    const otherId=other.result.output.targetId;
    assert.ok(otherId);
    for(let i=0;i<repetitions;i++){
      const focused=await call('browser.tab.focus','external',{targetId:i%2===0?targetId:otherId});
      report.tabSwitch.push(focused.ms);
    }
    // Previous diagnostic intentionally left targetId backgrounded. A production
    // foreground workflow must explicitly focus its target before the sequence.
    if(!skipWorkflowFocus)await call('browser.tab.focus','external',{targetId});
    report.workflowTargetFocused=!skipWorkflowFocus;
    report.backgroundFlags=backgroundFlags;
    report.focusEmulation=focusEmulation;
    if (focusEmulation) {
      const targets=await (await fetch('http://127.0.0.1:'+port+'/json/list')).json();
      const selected=targets.find(t=>t.id===targetId);
      assert.ok(selected?.webSocketDebuggerUrl,'Isolated synthetic target must have a CDP endpoint.');
      focusEmulationConnection=new CdpConnection(targetId,selected.webSocketDebuggerUrl);
      await focusEmulationConnection.send('Emulation.setFocusEmulationEnabled',{enabled:true});
      const status=await focusEmulationConnection.send('Runtime.evaluate',{
        expression:'({visible: document.visibilityState, focused: document.hasFocus()})',returnByValue:true});
      report.focusEmulationState=status?.result?.value ?? null;
    }
    for(let i=0;i<diagnosticCount;i++){
      const t=performance.now();
      await call('browser.inspect','read',{targetId});
      await call('browser.interact','external',{targetId,operation:'type',target:{css:'#f0'},value:'workflow-'+i});
      await call('browser.interact','external',{targetId,operation:'click',target:{css:'#tap'}});
      await call('browser.interact','external',{targetId,operation:'click',target:{css:'#spa'}});
      await call('browser.verify','read',{targetId,expect:{urlContains:'#/spa'}});
      report.fiveStep.push(performance.now()-t);
    }
    for(let i=0;i<repetitions;i++){
      const t=performance.now();
      const failed=await call('browser.interact','external',{targetId,operation:'click',target:{css:'#no-such-control'}},true);
      assert.equal(failed.result.ok,false);
      const recovered=await call('browser.inspect','read',{targetId});
      assert.equal(recovered.result.ok,true);
      report.failedRecovery.push(performance.now()-t);
    }
    for(let i=0;i<repetitions;i++){
      provider.close();
      report.coldSessionInspection.push((await call('browser.inspect','read',{targetId})).ms);
      report.warmSessionInspection.push((await call('browser.inspect','read',{targetId})).ms);
    }
  }
  const finish=await call('browser.inspect','read',{targetId});
  assert.equal(finish.result.ok,true);
  if (focusEmulationConnection) {
    await focusEmulationConnection.send('Emulation.setFocusEmulationEnabled',{enabled:false});
    const restored=await focusEmulationConnection.send('Runtime.evaluate',{
      expression:'({visible: document.visibilityState, focused: document.hasFocus()})',returnByValue:true});
    report.afterFocusEmulationRestore=restored?.result?.value??null;
    // The synthetic target MUST return to background semantics before exiting.
    assert.equal(report.afterFocusEmulationRestore?.focused,false,
      'Synthetic focus emulation did not restore the background target focus state');
    assert.equal(report.afterFocusEmulationRestore?.visible,'hidden',
      'Synthetic focus emulation did not restore the hidden target visibility state');
    focusEmulationConnection.close();
    focusEmulationConnection=undefined;
  }
  const result=extended ? {
    ...report,scenarioMode:'extended',navigation:samples(report.navigation),
    spa:samples(report.spa),tabSwitch:samples(report.tabSwitch),
    fiveStep:samples(report.fiveStep),failedRecovery:samples(report.failedRecovery),
    coldSessionInspection:samples(report.coldSessionInspection),
    warmSessionInspection:samples(report.warmSessionInspection)
  } : {...report,scenarioMode:'baseline',
    warmTabDiscovery:samples(report.warmTabDiscovery),
    warmSemanticInspection:samples(report.warmSemanticInspection),
    warmClick:samples(report.warmClick),tenFieldForm:samples(report.tenFieldForm)};
  const chromeMetadata=await (await fetch('http://127.0.0.1:'+port+'/json/version')).json();
  const sourceSha=execFileSync('git',['rev-parse','HEAD'],{cwd:process.cwd(),encoding:'utf8'}).trim();
  const metadata={sourceSha,runtimeVersion:process.env.MECORD_BENCH_RUNTIME_VERSION||'source-checkout',
    operatingSystem:os.type()+' '+os.release(),chromeVersion:String(chromeMetadata.Browser||'unknown'),
    machine:process.env.MECORD_BENCH_MACHINE||'original-Sampath-isolated-synthetic-Chrome',
    conditions:'isolated headless Chrome; loopback synthetic fixture; mode='+(extended?'extended':'baseline')+'; repetitions='+repetitions+'; fiveStepRepetitions='+diagnosticCount+'; backgroundFlags='+backgroundFlags+'; focusEmulation='+focusEmulation+'; workflowFocused='+(!skipWorkflowFocus)+'; hosted/model excluded'};
  const stageReport=pipelineLatency.report(metadata);
  const outputDir=path.resolve(process.env.MECORD_PIPELINE_REPORT_DIR||
    path.join(process.cwd(),'artifacts','pipeline-latency-'+new Date().toISOString().replace(/[:.]/g,'-')));
  await fs.mkdir(outputDir,{recursive:true});
  await fs.writeFile(path.join(outputDir,'stage-report.json'),JSON.stringify(stageReport,null,2)+'\n');
  await fs.writeFile(path.join(outputDir,'stage-report.md'),pipelineReportMarkdown(stageReport));
  await fs.writeFile(path.join(outputDir,'browser-scenarios.json'),JSON.stringify({...result,
    sourceSha,chromeVersion:metadata.chromeVersion,repetitions,measuredAt:new Date().toISOString()},null,2)+'\n');
  process.stdout.write('MECORD_PIPELINE_REPORT_DIR='+outputDir+'\n');
  process.stdout.write('MECORD_BROWSER_BENCHMARK_JSON='+JSON.stringify(result)+'\n');
} finally {
  if(focusEmulationConnection){
    await focusEmulationConnection.send('Emulation.setFocusEmulationEnabled',{enabled:false}).catch(()=>undefined);
    focusEmulationConnection.close();
  }
  provider?.close();
  // Only the process spawned with our dedicated temporary user-data-dir is owned by this script.
  if(chrome.exitCode===null) chrome.kill();
  await new Promise(resolve=>server.close(resolve));
  await delay(200);
  await fs.rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:150});
}


