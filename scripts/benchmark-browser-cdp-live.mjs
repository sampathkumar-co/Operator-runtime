import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { BrowserCdpProvider } from '../src/capabilities/browser-cdp.ts';

const samples = (values) => {
  const sorted = [...values].sort((a,b) => a-b);
  const quantile = (p) => sorted[Math.max(0,Math.ceil(p*sorted.length)-1)];
  return { count: sorted.length, p50Ms: +quantile(0.5).toFixed(1), p95Ms: +quantile(0.95).toFixed(1),
    maxMs: +sorted.at(-1).toFixed(1), meanMs: +(sorted.reduce((a,b)=>a+b,0)/sorted.length).toFixed(1) };
};
const delay = (ms) => new Promise(resolve=>setTimeout(resolve,ms));
const browserPath = process.env.MECORD_BENCH_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-isolated-browser-benchmark-'));
const page = '<!doctype html><html><head><title>Mecord Synthetic Fixture</title></head><body><h1>Local synthetic benchmark</h1>'
  + Array.from({length:10}, (_,i)=>'<label>Field '+i+'<input id="f'+i+'" type="text" aria-label="Field '+i+'"></label>').join('')
  + '<button id="tap" onclick="document.querySelector(\'#status\').textContent=String(Number(document.querySelector(\'#status\').textContent||0)+1);this.textContent=String(Date.now())">Tap</button><output id="status">0</output></body></html>';
const server = http.createServer((req,res)=> {
  res.setHeader('content-type','text/html; charset=utf-8');res.setHeader('cache-control','no-store');res.end(page);
});
const listen = new Promise((resolve,reject)=>{server.once('error',reject); server.listen(0,'127.0.0.1',resolve);});
await listen;
const fixture = 'http://127.0.0.1:'+server.address().port+'/';
const chrome = spawn(browserPath,['--headless=new','--no-first-run','--no-default-browser-check','--disable-extensions',
  '--disable-background-networking','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{
  windowsHide:true,stdio:'ignore'
});
let provider;
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
  const call=async(capability,risk,input)=>{
    const t=performance.now();
    const result=await provider.execute({id:'synthetic-bench-'+(++actionIndex),capability,risk,input,
      provenance:{kind:'runtime',source:'synthetic-benchmark'}});
    const ms=performance.now()-t;
    if(!result.ok)throw new Error(capability+' '+(result.error?.code||'UNKNOWN')+': '+(result.error?.message||'unknown'));
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
  for(let i=0;i<30;i++){
    const discovery=await call('browser.inspect','read',{});
    report.warmTabDiscovery.push(discovery.ms);
    const inspected=await call('browser.inspect','read',{targetId});
    report.warmSemanticInspection.push(inspected.ms);
    const click=await call('browser.interact','external',{targetId,operation:'click',target:{css:'#tap'}});
    report.warmClick.push(click.ms);
  }
  for(let j=0;j<10;j++){
    const t=performance.now();
    for(let i=0;i<10;i++){
      await call('browser.interact','external',{targetId,operation:'type',target:{css:'#f'+i},
        value:'test-'+j+'-'+i});
    }
    report.tenFieldForm.push(performance.now()-t);
  }
  const finish=await call('browser.inspect','read',{targetId});
  assert.equal(finish.result.ok,true);
  const result={...report, warmTabDiscovery:samples(report.warmTabDiscovery),
    warmSemanticInspection:samples(report.warmSemanticInspection),
    warmClick:samples(report.warmClick),tenFieldForm:samples(report.tenFieldForm)};
  process.stdout.write('MECORD_BROWSER_BENCHMARK_JSON='+JSON.stringify(result)+'\n');
} finally {
  provider?.close();
  // Only the process spawned with our dedicated temporary user-data-dir is owned by this script.
  if(chrome.exitCode===null) chrome.kill();
  await new Promise(resolve=>server.close(resolve));
  await delay(200);
  await fs.rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:150});
}
