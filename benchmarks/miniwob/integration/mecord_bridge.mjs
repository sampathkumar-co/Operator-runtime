// Isolated, source-pinned Mecord MiniWoB bridge. No production relay or credentials.
import http from 'node:http';import path from 'node:path';
import {timingSafeEqual} from 'node:crypto';
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
const bridgeToken=process.env.MECORD_MINIWOB_BRIDGE_TOKEN||'';
if(!/^[0-9a-f]{64}$/.test(bridgeToken))throw Error('BENCHMARK_BRIDGE_TOKEN_REQUIRED');
const expectedAuth=Buffer.from('Bearer '+bridgeToken,'utf8');
const authorized=header=>{
 if(typeof header!=='string')return false;
 const got=Buffer.from(header,'utf8');
 return got.length===expectedAuth.length&&timingSafeEqual(got,expectedAuth);
};
let provider=new BrowserCdpProvider(endpoint),inspectState=null,sequence=0,busy=false;
const project=item=>({
 ref:item.ref,role:item.role||'',tag:item.tag||'',primitive:item.primitive||'',
 name:item.name||'',type:item.type||'',actionable:item.actionable===true,disabled:item.disabled===true,
 groupRole:item.groupRole||'',semanticPath:item.semanticPath||'',scrollable:item.scrollable===true,
 editable:item.editable===true,value:typeof item.value==='string'?item.value.slice(0,160):'',
 checked:typeof item.checked==='boolean'?item.checked:null,
 selected:typeof item.selected==='boolean'?item.selected:null,
 expanded:typeof item.expanded==='boolean'?item.expanded:null,
 placeholder:typeof item.placeholder==='string'?item.placeholder.slice(0,100):'',
 repeatedOrdinal:Number.isInteger(item.repeatedOrdinal)?item.repeatedOrdinal:null,
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
 if(!authorized(req.headers.authorization)){res.writeHead(403).end('{"ok":false,"error":"BRIDGE_AUTH_REQUIRED"}');return;}
 if(busy){res.writeHead(409).end('{"ok":false,"error":"BRIDGE_CONCURRENT_REQUEST"}');return;}
 busy=true;
 let body='';
 try{
  for await(const chunk of req){body+=chunk.toString();if(body.length>10000)throw Error('ACTION_TOO_LARGE');}
  const input=JSON.parse(body);
  if(!input||typeof input!=='object'||Array.isArray(input))throw Error('INVALID_ACTION');
  const targetId=await exactTarget();
  if(input.op==='inspect'){
   if(Object.keys(input).some(k=>k!=='op'))throw Error('EXTRA_INSPECT_PARAMETERS');
   inspectState=null;
   const action={id:'miniwob-inspect-'+(++sequence),capability:'browser.inspect',risk:'read',
    input:{targetId,observation:{maxControls:160,maxVisuals:160,maxBytes:131072}}};
   const out=await provider.execute(action);
   if(!out.ok||out.provider!=='browser.cdp')throw Error('PROVIDER_INSPECT_FAILED_'+(out.error?.code||'UNKNOWN'));
   if(out.output?.truncated===true)throw Error('PROVIDER_OBSERVATION_TRUNCATED');
   const semantic=out.output?.page?.semantic;
   if(!semantic||typeof semantic.observationGeneration!=='string')throw Error('NO_SEMANTIC_OBSERVATION');
   if(!Array.isArray(semantic.controls)||!Array.isArray(semantic.visuals))throw Error('MISSING_OBSERVATION_ARRAYS');
   const generation=semantic.observationGeneration;
   const controls=semantic.controls.slice(0,160).map(project),visuals=semantic.visuals.slice(0,160).map(project);
   // A genuine observed page-scroller ref is not in normal controls/visuals.
   const ps=semantic.pageScroll;
   if(ps&&typeof ps.ref==='string'&&refRE.test(ps.ref)&&ps.ref.startsWith('b-'+generation+'-')&&ps.geometry){
    visuals.unshift(project({ref:ps.ref,role:'scrollbar',tag:'div',name:'Page scroller',
     actionable:false,scrollable:true,context:{frameDepth:0,shadowDepth:0},geometry:ps.geometry}));
   }
   const refs=new Set(),relativeRefs=new Set(),sortableRefs=new Set(),scrollRefs=new Set(),controlInfo=new Map();
   const svgGeometry=new Set(['text','circle','ellipse','rect','path','polygon','polyline','line']);
   for(const item of [...controls,...visuals]){
    if(item.disabled===true||typeof item.ref!=='string')continue;
    if(!refRE.test(item.ref)||!item.ref.startsWith('b-'+generation+'-'))continue;
    if(item.context.frameDepth!==0)continue;
    controlInfo.set(item.ref,item);
    if(item.actionable===true)refs.add(item.ref);
    else if(visuals.includes(item)&&svgGeometry.has(item.tag))relativeRefs.add(item.ref);
    if(item.scrollable===true)scrollRefs.add(item.ref);
    if(visuals.includes(item)&&item.groupRole==='li'&&
       item.semanticPath.toLowerCase().includes('sortable')&&
       new Set(['div','li','span']).has(item.tag))sortableRefs.add(item.ref);
   }
   inspectState={targetId,generation,refs,relativeRefs,sortableRefs,scrollRefs,controlInfo};
   res.end(JSON.stringify({ok:true,provider:out.provider,durationMs:out.durationMs,
    textExcerpt:typeof semantic.textExcerpt==='string'?semantic.textExcerpt.slice(0,1200):'',
    headings:Array.isArray(semantic.headings)?semantic.headings.filter(x=>typeof x==='string').slice(0,20):[],
    pagination:semantic.pagination||null,
    page:{semantic:{observationGeneration:generation,controls,visuals}},
    observedRefCount:refs.size,visualRelativeRefs:relativeRefs.size,sortableRefs:sortableRefs.size,scrollRefs:scrollRefs.size,truncated:out.output?.truncated===true}));
   return;
  }
  const allowed=new Set(['click','hover','set_value','type','select','select_date','key_press','click_relative','scroll','drag_between','drag_by','resize','hotkey','keyboard_text','format_text','select_text_range']);
  if(!allowed.has(input.op))throw Error('UNSUPPORTED_INTERACTION');
  if(!inspectState||inspectState.targetId!==targetId)throw Error('FRESH_INSPECTION_REQUIRED');
  const ref=input.ref;
  if(typeof ref!=='string'||!refRE.test(ref))throw Error('BAD_REF_FORMAT');
  const allowedRefs=(input.op==='click_relative'?inspectState.relativeRefs:
    input.op==='drag_between'?inspectState.sortableRefs:
    input.op==='scroll'?inspectState.scrollRefs:
   input.op==='drag_by'||input.op==='resize'?new Set([...inspectState.refs,...inspectState.relativeRefs]):inspectState.refs);
  if(!allowedRefs.has(ref))throw Error('REF_NOT_FROM_FRESH_INSPECTION');
  const observed=inspectState.controlInfo.get(ref);
  if(input.op==='type'||input.op==='set_value'||input.op==='keyboard_text'||input.op==='format_text'||input.op==='select_text_range'){
   const role=String(observed?.role||observed?.tag||'').toLowerCase();
   if(!observed||(observed.editable!==true&&!new Set(['textbox','searchbox','combobox','spinbutton','input','textarea']).has(role)
    && !(input.op==='set_value'&&role==='slider')))throw Error('TARGET_NOT_EDITABLE');
  }
  if(input.op==='select_date' && observed?.type!=='date')throw Error('DATE_TARGET_NOT_DATE_INPUT');
  if(input.op==='select'){
   const role=String(observed?.role||observed?.tag||'').toLowerCase();
   if(!observed||!new Set(['select','combobox','listbox','option']).has(role))throw Error('TARGET_NOT_SELECTABLE');
  }
  if(Object.keys(input).some(k=>!['op','ref','value','key'].includes(k)))throw Error('EXTRA_MODEL_PARAMETERS');
  // Provider set_value is reserved for sliders; native text inputs use type
  // (which safely replaces the current value, including clear-to-empty).
  const dispatchOp=input.op==='set_value' && observed?.role!=='slider' ? 'type' : input.op;
  const actionInput={targetId,operation:dispatchOp,target:{ref}};
  if(input.op==='click_relative'){actionInput.xRatio=0.5;actionInput.yRatio=0.5;}
  if(['type','set_value','select','select_date','keyboard_text','format_text','select_text_range'].includes(input.op)){
   if(typeof input.value!=='string'||(input.value.length===0&&input.op!=='set_value')||input.value.length>400)throw Error('INVALID_TEXT_VALUE');
   if(input.op==='select_date'&&!/^\d{4}-\d{2}-\d{2}$/.test(input.value))throw Error('DATE_VALUE_INVALID');
   actionInput.value=input.value;
  }
  if(input.op==='scroll'){
   const match=/^(up|down)(?::(80|160|320))?$/.exec(input.value);
   if(!match)throw Error('INVALID_SCROLL_DIRECTION');
   actionInput.deltaX=0;
   actionInput.deltaY=(match[1]==='up'?-1:1)*Number(match[2]||80);
  }
  if(input.op==='drag_by'||input.op==='resize'){
   const match=/^(left|right|up|down):(40|80|160)$/.exec(input.value);
   if(!match)throw Error('INVALID_DISPLACEMENT');
   const delta=Number(match[2]);
   actionInput.deltaX=match[1]==='left'?-delta:match[1]==='right'?delta:0;
   actionInput.deltaY=match[1]==='up'?-delta:match[1]==='down'?delta:0;
  }
  if(input.op==='format_text'&&!new Set(['bold','italic','underline']).has(input.value))throw Error('INVALID_FORMAT');
  if(input.op==='select_text_range'){
   const match=/^(0|[1-9][0-9]{0,3}):(0|[1-9][0-9]{0,3})$/.exec(input.value);
   if(!match||Number(match[1])>Number(match[2]))throw Error('INVALID_TEXT_RANGE');
   actionInput.start=Number(match[1]);actionInput.end=Number(match[2]);
   delete actionInput.value;
  }
  if(input.op==='hotkey'){
   if(!new Set(['CTRL+A','CTRL+C','CTRL+V','CTRL+Z','CTRL+SHIFT+Z','CTRL+B','CTRL+I','CTRL+U']).has(input.key))throw Error('INVALID_HOTKEY');
   actionInput.keys=input.key.split('+');
  }
  if(input.op==='drag_between'){
   const toRef=input.value;
   if(typeof toRef!=='string'||!refRE.test(toRef)||toRef===ref||!inspectState.sortableRefs.has(toRef)||
      toRef.slice(0,toRef.lastIndexOf('-'))!==ref.slice(0,ref.lastIndexOf('-')))throw Error('DRAG_TARGETS_NOT_CURRENT_SORTABLE');
   actionInput.toTarget={ref:toRef};
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
    error:result.error?.code||null,
    sideEffectState:result.error?.details?.sideEffectState||null,
    executionPhase:result.error?.details?.executionPhase||null,
    stateProgress:result.output?.stateDelta?.progress===true,
    repeatedNoProgress:result.output?.stateDelta?.repeatedNoProgress||0,
    needsReobserve:true}));
 }catch(e){inspectState=null;error(res,e?.message||e);}
 finally{busy=false;}
});
svr.listen(0,'127.0.0.1',()=>console.log('MECORD_BRIDGE_PORT='+svr.address().port));
process.on('SIGTERM',()=>{inspectState=null;try{provider.close()}catch{}svr.close()});
