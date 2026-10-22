/* Isolated native-observation browser bridge. No arbitrary sites or selectors. */
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const project=process.env.MECORD_PROVIDER_ROOT||path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..','..');
const {BrowserCdpProvider}=await import(pathToFileURL(path.join(project,'src','capabilities','browser-cdp.ts')).href);
const cdpPort=String(process.env.MECORD_BENCH_CDP_PORT||'9360');
if(!/^9[0-9]{3}$/.test(cdpPort))throw Error('INVALID_ISOLATED_PORT');
const cdp='http://127.0.0.1:'+cdpPort;
const allowed=process.env.MINIWOB_URL||'';
if(!allowed.startsWith('file:///')||!allowed.endsWith('/'))throw Error('LOCAL_MINIWOB_URL_REQUIRED');
let provider=new BrowserCdpProvider(cdp);
let snapshot=0;let targets=new Map();let sequence=0;
const cap=(v,n=140)=>typeof v==='string'?v.slice(0,n):'';
async function pageId(){
 const req=await fetch(cdp+'/json/list',{signal:AbortSignal.timeout(4000)});
 if(!req.ok)throw Error('CDP_DISCOVERY_FAILED');
 const tabs=await req.json();
 const scoped=tabs.filter(t=>t.type==='page'&&typeof t.url==='string'&&t.url.startsWith(allowed));
 if(scoped.length!==1)throw Error('SCOPE_NOT_UNIQUE');
 return scoped[0].id;
}
function addCandidate(list,node,source){
 const ref=cap(node?.ref,128);
 if(!ref||![...targets.values()].every(v=>v!==ref)||list.length>=160)return;
 const id='e'+(list.length+1);
 targets.set(id,ref);
 list.push({id,source,role:cap(node.role||node.tag||node.primitive,48),
 name:cap(node.name||node.text||node.value,140),
 ...(node.rect&&typeof node.rect==='object'?{rect:node.rect}:{}),
 ...(node.scrollable?{scrollable:true}:{}),
 ...(node.scroll?{scroll:node.scroll}:{}),
 ...(node.numericValue!==undefined?{numericValue:node.numericValue}:{}),
 ...(node.geometry?{geometry:node.geometry}:{})});
}
function asDelta(v){const n=Number(v);if(!Number.isFinite(n)||Math.abs(n)>2000)return null;return n}
const operations=new Set(['click','hover','type','set_value','select','select_date','key_press','drag','drag_by','drag_between','resize','scroll','click_relative','keyboard_text','format_text','select_text_range']);
const server=http.createServer(async(req,res)=>{
 res.setHeader('content-type','application/json');
 if(req.method!=='POST'||!['/inspect','/act'].includes(req.url||'')){res.writeHead(404);res.end('{}');return}
 let data='';try{
  for await(const chunk of req){data+=String(chunk);if(data.length>12000)throw Error('PAYLOAD_TOO_LARGE')}
  const input=data?JSON.parse(data):{};
  const targetId=await pageId();
  if(req.url==='/inspect'){
    const result=await provider.execute({id:'bench-inspect-'+(++sequence),capability:'browser.inspect',risk:'read',
      input:{targetId,observation:{maxControls:110,maxVisuals:90,maxText:90,maxBytes:90000}},
      provenance:{kind:'runtime',source:'isolated-miniwob'}});
    if(!result.ok)throw Error('INSPECT_'+(result.error?.code||'UNKNOWN'));
    snapshot++;targets=new Map();
    const sem=result.output?.page?.semantic||{};
    const list=[];
    for(const x of (sem.controls||[]))addCandidate(list,x,'control');
    for(const x of (sem.visualObjects||[]))addCandidate(list,x,'visual');
    if(sem.pageScroll)addCandidate(list,sem.pageScroll,'page-scroll');
    res.end(JSON.stringify({ok:true,snapshot,candidates:list,
      visibleText:(sem.visibleText||[]).slice(0,25).map(x=>cap(typeof x==='string'?x:x.text,150)),
      textExcerpt:cap(sem.textExcerpt,900),provider:result.provider,durationMs:result.durationMs}));
    return;
  }
  if(input.snapshot!==snapshot)throw Error('STALE_OBSERVATION');
  const op=String(input.op||'');
  if(!operations.has(op))throw Error('OP_DENIED');
  const ref=targets.get(String(input.id||''));
  if(!ref)throw Error('UNOBSERVED_REF');
  const payload={targetId,operation:op,target:{ref}};
  if(op==='drag_between'){
    const to=targets.get(String(input.toId||''));
    if(!to||to===ref)throw Error('INVALID_DESTINATION');
    payload.toTarget={ref:to};
  }
  if(['drag','drag_by','resize','scroll'].includes(op)){
    const dx=asDelta(input.deltaX??0),dy=asDelta(input.deltaY??0);
    if(dx===null||dy===null||(dx===0&&dy===0))throw Error('INVALID_DELTA');
    payload.deltaX=dx;payload.deltaY=dy;
  }
  if(op==='click_relative'){
    const x=Number(input.xRatio),y=Number(input.yRatio);
    if(!Number.isFinite(x)||!Number.isFinite(y)||x<0||y<0||x>1||y>1)throw Error('INVALID_RELATIVE_POINT');
    payload.xRatio=x;payload.yRatio=y;
  }
  if(['set_value','type','select','select_date','keyboard_text','format_text'].includes(op)){
    const value=String(input.value||'').slice(0,400);
    if(!value)throw Error('MISSING_VALUE');
    payload.value=value;
  }
  if(op==='select_date'&&!/^\d{4}-\d{2}-\d{2}$/.test(payload.value))throw Error('INVALID_DATE');
  if(op==='key_press'){const key=cap(input.key,32);if(!key)throw Error('MISSING_KEY');payload.key=key}
  if(op==='select_text_range'){
    const start=Number(input.start),end=Number(input.end);
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<start||end>10000)throw Error('INVALID_RANGE');
    payload.start=start;payload.end=end;
  }
  // Consume snapshot before dispatch: the caller must re-observe after any result,
  // including uncertainty. This bridge cannot blindly replay the same action.
  snapshot++;targets.clear();
  const result=await provider.execute({id:'bench-native-'+(++sequence),capability:'browser.interact',risk:'external',
    input:payload,provenance:{kind:'runtime',source:'isolated-miniwob'}});
  res.end(JSON.stringify({ok:result.ok,error:result.error?.code||null,
    sideEffectState:result.error?.sideEffectState||null,provider:result.provider,durationMs:result.durationMs}));
 }catch(e){res.writeHead(400);res.end(JSON.stringify({ok:false,error:cap(e?.message||String(e),160)}))}
});
server.listen(0,'127.0.0.1',()=>console.log('NATIVE_BRIDGE_PORT='+server.address().port));
process.on('SIGTERM',()=>{provider.close();server.close()});
