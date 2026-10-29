// Isolated, source-pinned Mecord MiniWoB bridge. No production relay or credentials.
import http from 'node:http';import os from 'node:os';import path from 'node:path';
import {pathToFileURL} from 'node:url';import {readFile} from 'node:fs/promises';
const dir=process.env.MECORD_MINIWOB_WORKDIR ? path.resolve(process.env.MECORD_MINIWOB_WORKDIR) : null;
if(!dir)throw Error('MECORD_MINIWOB_WORKDIR_REQUIRED');
const root=process.env.MECORD_MINIWOB_RUNTIME_PATH ? path.resolve(process.env.MECORD_MINIWOB_RUNTIME_PATH) : null;
if(!root)throw Error('MECORD_MINIWOB_RUNTIME_PATH_REQUIRED');
const manifest=JSON.parse(await readFile(path.join(root,'runtime','runtime-manifest.json'),'utf8'));
if(manifest.version!=='2.0.7-rc.6'||manifest.sourceCommit!=='beef93d3aa9c2c1363e92a6b3b78c893bf1a0ad4')throw Error('UNPINNED_RUNTIME');
const {BrowserCdpProvider}=await import(pathToFileURL(path.join(root,'runtime','app','src','capabilities','browser-cdp.js')).href);
const port=Number(process.env.MECORD_BENCH_CDP_PORT||9330);
if(!Number.isInteger(port)||port<9300||port>9399)throw Error('INVALID_LOCAL_CDP_PORT');
const endpoint='http://127.0.0.1:'+port;
const prefix=pathToFileURL(path.join(dir,'miniwob-plusplus','miniwob','html','miniwob')+path.sep).href;
const refRE=/^b-([a-z0-9]+)-([a-z0-9]+)-([a-z0-9]+)$/;
let provider=new BrowserCdpProvider(endpoint),inspectState=null,sequence=0;
const project=item=>({
 ref:item.ref,role:item.role||'',tag:item.tag||'',primitive:item.primitive||'',
 name:item.name||'',actionable:item.actionable===true,disabled:item.disabled===true,
 context:{frameDepth:item.context?.frameDepth,shadowDepth:item.context?.shadowDepth},
 geometry:item.geometry||item.rect,
 perceptibleState:{text:item.perceptibleState?.text||''}
});
const error=(res,msg)=>{res.writeHead(400);res.end(JSON.stringify({ok:false,error:String(msg).slice(0,120)}));};
async function exactTarget(){
 const response=await fetch(endpoint+'/json/list',{signal:AbortSignal.timeout(3500)});
 if(!response.ok)throw Error('CDP_DISCOVERY_UNAVAILABLE');
 const items=await response.json();
 if(!Array.isArray(items))throw Error('INVALID_CDP_TABS');
 const tabs=items.filter(t=>t&&t.type==='page'&&typeof t.url==='string'&&t.url.startsWith(prefix));
 if(tabs.length!==1)throw Error('TASK_TAB_NOT_UNIQUE');
 return tabs[0].id;
}
const svr=http.createServer(async(req,res)=>{
 res.setHeader('content-type','application/json');res.setHeader('cache-control','no-store');
 if(req.method!=='POST'||req.url!=='/execute'){res.writeHead(404).end('{}');return;}
 let body='';
 try{
  for await(const chunk of req){body+=chunk.toString();if(body.length>10000)throw Error('ACTION_TOO_LARGE');}
  const input=JSON.parse(body);
  if(!input||typeof input!=='object'||Array.isArray(input))throw Error('INVALID_ACTION');
  const targetId=await exactTarget();
  if(input.op==='inspect'){
   inspectState=null;
   const action={id:'miniwob-inspect-'+(++sequence),capability:'browser.inspect',risk:'read',
    input:{targetId,observation:{maxControls:160,maxVisuals:160,maxBytes:131072}}};
   const out=await provider.execute(action);
   if(!out.ok||out.provider!=='browser.cdp')throw Error('PROVIDER_INSPECT_FAILED_'+(out.error?.code||'UNKNOWN'));
   const semantic=out.output?.page?.semantic;
   if(!semantic||typeof semantic.observationGeneration!=='string')throw Error('NO_SEMANTIC_OBSERVATION');
   if(!Array.isArray(semantic.controls)||!Array.isArray(semantic.visuals))throw Error('MISSING_OBSERVATION_ARRAYS');
   const generation=semantic.observationGeneration;
   const controls=semantic.controls.slice(0,160).map(project),visuals=semantic.visuals.slice(0,160).map(project);
   const refs=new Set();
   for(const item of [...controls,...visuals]){
    if(item.actionable!==true||item.disabled===true||typeof item.ref!=='string')continue;
    if(!refRE.test(item.ref)||!item.ref.startsWith('b-'+generation+'-'))continue;
    if(item.context.frameDepth!==0)continue;
    refs.add(item.ref);
   }
   inspectState={targetId,generation,refs};
   res.end(JSON.stringify({ok:true,provider:out.provider,durationMs:out.durationMs,
    page:{semantic:{observationGeneration:generation,controls,visuals}},
    observedRefCount:refs.size,truncated:out.output?.truncated===true}));
   return;
  }
  const allowed=new Set(['click','hover','set_value','type','select','key_press']);
  if(!allowed.has(input.op))throw Error('UNSUPPORTED_INTERACTION');
  if(!inspectState||inspectState.targetId!==targetId)throw Error('FRESH_INSPECTION_REQUIRED');
  const ref=input.ref;
  if(typeof ref!=='string'||!refRE.test(ref)||!inspectState.refs.has(ref))throw Error('REF_NOT_FROM_FRESH_INSPECTION');
  if(Object.keys(input).some(k=>!['op','ref','value','key'].includes(k)))throw Error('EXTRA_MODEL_PARAMETERS');
  const actionInput={targetId,operation:input.op,target:{ref}};
  if(['type','set_value','select'].includes(input.op)){
   if(typeof input.value!=='string'||!input.value||input.value.length>400)throw Error('INVALID_TEXT_VALUE');
   actionInput.value=input.value;
  }
  if(input.op==='key_press'){
   if(typeof input.key!=='string'||!/^[A-Za-z][A-Za-z0-9+_-]{0,31}$/.test(input.key))throw Error('INVALID_KEY');
   actionInput.key=input.key;
  }
  // The action may be uncertain even after an RPC error. Never replay it
  // without another independent observation and host reconciliation.
  inspectState=null;
  const action={id:'miniwob-action-'+(++sequence),capability:'browser.interact',risk:'external',input:actionInput,
   provenance:{kind:'runtime',source:'isolated-benchmark'}};
  const result=await provider.execute(action);
  res.end(JSON.stringify({ok:result.ok===true,provider:result.provider,durationMs:result.durationMs,
    error:result.error?.code||null,needsReobserve:true}));
 }catch(e){inspectState=null;error(res,e?.message||e);}
});
svr.listen(0,'127.0.0.1',()=>console.log('MECORD_BRIDGE_PORT='+svr.address().port));
process.on('SIGTERM',()=>{inspectState=null;try{provider.close()}catch{}svr.close()});
