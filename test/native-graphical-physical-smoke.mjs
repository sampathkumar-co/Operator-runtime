// Credential-free physical smoke against the actual Mecord source CDP provider.
// Never connects to ordinary Chrome sessions or personal browser profiles.
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {BrowserCdpInspectProvider} from '../src/capabilities/browser-cdp.ts';
import {CdpConnection} from '../src/capabilities/browser-cdp-connection.ts';

const chrome='C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const root=await mkdtemp(join(tmpdir(),'mecord-native-gesture-smoke-'));
const port=19437,endpoint='http://127.0.0.1:'+port;
const html=join(root,'fixture.html');
await writeFile(html,`<!doctype html><meta charset="utf-8"><style>
button{margin:18px;width:170px;height:65px;}canvas{display:block;margin:20px;border:2px solid black}
</style><button id="dbl">Double click</button><button id="shift">Shift click</button>
<canvas id="draw" role="img" aria-label="Drawing canvas" width="250" height="140"></canvas>
<script>
window.eventLog={dbl:0,shift:0,down:0,moves:0,up:0};
document.querySelector('#dbl').addEventListener('dblclick',()=>window.eventLog.dbl++);
document.querySelector('#shift').addEventListener('click',e=>{if(e.shiftKey)window.eventLog.shift++});
const c=document.querySelector('#draw');
c.addEventListener('pointerdown',()=>window.eventLog.down++);
c.addEventListener('pointermove',e=>{if(e.buttons&1)window.eventLog.moves++});
c.addEventListener('pointerup',()=>window.eventLog.up++);
</script>`,'utf8');
const browser=spawn(chrome,['--headless=new','--no-first-run','--no-default-browser-check','--disable-gpu','--remote-allow-origins=*',
 '--remote-debugging-address=127.0.0.1','--remote-debugging-port='+port,'--user-data-dir='+join(root,'chrome'),pathToFileURL(html).href],{stdio:'ignore'});
let provider=null,session=null;
try{
 let target;
 for(let i=0;i<65;i++){
  if(browser.exitCode!==null)throw Error('CHROME_EXIT_'+browser.exitCode);
  try{
   const reply=await fetch(endpoint+'/json/list',{signal:AbortSignal.timeout(1800)});
   if(reply.ok){const tabs=await reply.json();target=tabs.find(t=>t.type==='page'&&t.url===pathToFileURL(html).href);if(target)break;}
  }catch{}
  await new Promise(resolve=>setTimeout(resolve,150));
 }
 if(!target)throw Error('ISOLATED_FIXTURE_TARGET_UNAVAILABLE');
 provider=new BrowserCdpInspectProvider(endpoint);
 const inspect=async()=>{
  const response=await provider.execute({id:'native-inspect',capability:'browser.inspect',risk:'read-only',input:{targetId:target.id},provenance:{kind:'runtime'}});
  if(!response.ok)throw Error('INSPECT_FAILED '+JSON.stringify(response.error));
  return response.output.page.semantic;
 };
 const find=async (name,tag='controls')=>{
  const semantic=await inspect();
  const options=tag==='visuals'?(semantic.visuals||semantic.visualObjects||[]):semantic.controls;
  const match=options.find(x=>x.name===name || (tag==='visuals'&&x.tag==='canvas'));
  if(!match?.ref)throw Error('MISSING_OBSERVED_REF '+name+' '+JSON.stringify(options.map(x=>({name:x.name,tag:x.tag,ref:x.ref})).slice(0,25)));
  return match.ref;
 };
 const exec=async(operation,ref,extras={})=>{
  const result=await provider.execute({id:'native-'+operation,capability:'browser.interact',risk:'external',
   input:{targetId:target.id,operation,target:{ref},...extras},provenance:{kind:'runtime',source:'isolated-gesture-smoke'}});
  if(!result.ok)throw Error('NATIVE_'+operation+'_FAILED '+JSON.stringify(result.error));
  return result;
 };
 session=new CdpConnection(target.id,target.webSocketDebuggerUrl);
 const counts=async()=>{
  const res=await session.send('Runtime.evaluate',{expression:'JSON.stringify(window.eventLog)',returnByValue:true});
  return JSON.parse(res.result.value);
 };
 await exec('double_click',await find('Double click'));
 await exec('shift_click',await find('Shift click'));
 const ref=await find('Drawing canvas','visuals');
 await exec('drag_path',ref,{path:[{xRatio:0.2,yRatio:0.3},{xRatio:0.4,yRatio:0.45},{xRatio:0.6,yRatio:0.6},{xRatio:0.8,yRatio:0.7}]});
 const result=await counts();
 if(result.dbl!==1||result.shift!==1||result.down<1||result.moves<2||result.up<1)throw Error('NATIVE_GESTURE_DOM_NOT_PROVEN '+JSON.stringify(result));
 process.stdout.write('NATIVE_PROVIDER_PHYSICAL_SMOKE_PASS '+JSON.stringify(result)+'\n');
}finally{
 try{session?.close()}catch{}
 try{provider?.close()}catch{}
 browser.kill();
 await new Promise(resolve=>setTimeout(resolve,450));
 await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:250});
}
