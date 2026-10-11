/** Read-only smoke: separate owned headless Chromium; never connects to user Chrome. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { ManagedBrowserProvider } from '../src/capabilities/browser-managed.ts';

const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'mecord-owned-browser-smoke-'));
const server=http.createServer((request,response)=>{
 response.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});
 response.end('<!doctype html><title>Owned synthetic</title><button id="tap" onclick="document.getElementById(\'out\').textContent=\'clicked\'">Tap</button><output id="out">idle</output>');
});
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
const fixture='http://127.0.0.1:'+server.address().port+'/';
const provider=new ManagedBrowserProvider({
 dedicatedProfileOnly:true,dataDir,launchTimeoutMs:15_000,
 ...(process.env.MECORD_BENCH_CHROME?{executablePath:process.env.MECORD_BENCH_CHROME}:{})
});
try{
 const outcomes=await Promise.all(Array.from({length:3},(_,i)=>provider.execute({
  id:'synthetic-owned-browser-inspect-'+i,
  capability:'browser.inspect',risk:'read',input:{},
  provenance:{kind:'runtime',source:'isolated-managed-smoke'}
 })));
 assert.ok(outcomes.every(o=>o.ok && o.provider==='browser.managed'),
  'Concurrent startup must share one owned Chrome process and complete all three independent reads.');
 const outcome=outcomes[0];
 assert.equal(outcome.provider,'browser.managed');
 const navigate=await provider.execute({id:'owned-nav',capability:'browser.navigate',risk:'external',
  input:{url:fixture,newTab:true},provenance:{kind:'runtime',source:'isolated-managed-smoke'}});
 assert.equal(navigate.ok,true,'Synthetic loopback navigation must succeed on owned Chrome');
 const targetId=navigate.output.targetId;
 assert.ok(targetId);
 const focus=await provider.execute({id:'owned-focus',capability:'browser.tab.focus',risk:'external',
  input:{targetId},provenance:{kind:'runtime',source:'isolated-managed-smoke'}});
 assert.equal(focus.ok,true,'Explicit focus in owned Chrome must succeed');
 const click=await provider.execute({id:'owned-click',capability:'browser.interact',risk:'external',
  input:{targetId,operation:'click',target:{css:'#tap'}},
  provenance:{kind:'runtime',source:'isolated-managed-smoke'}});
 assert.equal(click.ok,true,'Native browser mouse click must succeed on the owned Chrome instance');
 const verify=await provider.execute({id:'owned-verify',capability:'browser.verify',risk:'read',
  input:{targetId,expect:{textContains:'clicked'}},
  provenance:{kind:'runtime',source:'isolated-managed-smoke'}});
 assert.equal(verify.ok,true);
 assert.equal(verify.output.status,'VERIFIED','Synthetic postcondition must prove the click changed the page');
 console.log('MECORD_OWNED_BROWSER_SMOKE='+JSON.stringify({
  ok:outcome.ok,provider:outcome.provider,
  profile:'temporary-isolated',network:'loopback-CDP-only',noUserBrowserAttached:true}));
}finally{
 await provider.close();
 await new Promise(resolve=>server.close(resolve));
 await fs.rm(dataDir,{recursive:true,force:true,maxRetries:5,retryDelay:150});
}
