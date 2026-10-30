// Isolated, source-pinned Mecord MiniWoB bridge. No production relay or credentials.
import http from 'node:http';import path from 'node:path';
import {timingSafeEqual} from 'node:crypto';
import {providerOperationForInput,boundedScrollDelta,boundedDisplacement,boundedRelativePoint,boundedVisiblePageText,validatedDialogPrompt} from './bridge_actions.mjs';
import {captureSyntheticView,allowedSyntheticFrameUrl} from './browser_visual.mjs';
import {pathToFileURL} from 'node:url';import {readFile} from 'node:fs/promises';
const dir=process.env.MECORD_MINIWOB_WORKDIR ? path.resolve(process.env.MECORD_MINIWOB_WORKDIR) : null;
if(!dir)throw Error('MECORD_MINIWOB_WORKDIR_REQUIRED');
const root=process.env.MECORD_MINIWOB_RUNTIME_PATH ? path.resolve(process.env.MECORD_MINIWOB_RUNTIME_PATH) : null;
if(!root)throw Error('MECORD_MINIWOB_RUNTIME_PATH_REQUIRED');
const manifest=JSON.parse(await readFile(path.join(root,'runtime','runtime-manifest.json'),'utf8'));
if(manifest.version!=='2.0.7-rc.6'||manifest.sourceCommit!=='beef93d3aa9c2c1363e92a6b3b78c893bf1a0ad4')throw Error('UNPINNED_RUNTIME');
const {BrowserCdpProvider}=await import(pathToFileURL(path.join(root,'runtime','app','src','capabilities','browser-cdp.js')).href);
const {CdpConnection}=await import(pathToFileURL(path.join(root,'runtime','app','src','capabilities','browser-cdp-connection.js')).href);
const port=Number(process.env.MECORD_BENCH_CDP_PORT||9330);
if(!Number.isInteger(port)||port<9300||port>9399)throw Error('INVALID_LOCAL_CDP_PORT');
const endpoint='http://127.0.0.1:'+port;
const prefix=pathToFileURL(path.join(dir,'miniwob-plusplus','miniwob','html','miniwob')+path.sep).href;
const frameOrigins=(process.env.MECORD_MINIWOB_FRAME_ORIGINS||'').split(',').filter(Boolean);
for(const origin of frameOrigins){const u=new URL(origin);
 if(u.origin!==origin||!['http:','https:'].includes(u.protocol)||u.username||u.password)throw Error('FRAME_ORIGIN_INVALID');}
const refRE=/^b-([a-z0-9]+)-([a-z0-9]+)-([a-z0-9]+)$/;
const dialogRE=/^bd-[0-9a-f]{16}-[1-9a-z][0-9a-z]*-[0-9a-f]{12}$/;
const bridgeToken=process.env.MECORD_MINIWOB_BRIDGE_TOKEN||'';
if(!/^[0-9a-f]{64}$/.test(bridgeToken))throw Error('BENCHMARK_BRIDGE_TOKEN_REQUIRED');
const expectedAuth=Buffer.from('Bearer '+bridgeToken,'utf8');
const authorized=header=>{
 if(typeof header!=='string')return false;
 const got=Buffer.from(header,'utf8');
 return got.length===expectedAuth.length&&timingSafeEqual(got,expectedAuth);
};
let provider=new BrowserCdpProvider(endpoint),inspectState=null,sequence=0,busy=false;
const finite=n=>typeof n==='number'&&Number.isFinite(n)&&Math.abs(n)<100000?n:null;
const safePoint=p=>p&&typeof p==='object'?{x:finite(p.x),y:finite(p.y)}:null;
const safeColor=(x)=>typeof x==='string'?x.slice(0,64):'';
const project=(item,sourceGeneration='',frameTargetId='')=>({
 observationGeneration:sourceGeneration,
 sourceFrameTargetId:frameTargetId||(item.context?.frameDepth>0?'same-origin-main':''),
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
 perceptibleState:{text:typeof item.perceptibleState?.text==='string'?item.perceptibleState.text.slice(0,200):''},
 colors:{fill:safeColor(item.colors?.fill||item.perceptibleState?.colors?.fill),
   stroke:safeColor(item.colors?.stroke||item.perceptibleState?.colors?.stroke),
   background:safeColor(item.colors?.background||item.perceptibleState?.colors?.background),
   color:safeColor(item.colors?.color||item.perceptibleState?.colors?.color)},
 numericValue:finite(item.numericValue),
 viewportZone:typeof item.viewportZone==='string'?item.viewportZone.slice(0,40):'',
 shape:{center:safePoint(item.viewportCenter),
   circle:item.circle&&typeof item.circle==='object'?{cx:finite(item.circle.cx),cy:finite(item.circle.cy),r:finite(item.circle.r)}:null,
   line:item.viewportLine&&typeof item.viewportLine==='object'?{
    x1:finite(item.viewportLine.x1),y1:finite(item.viewportLine.y1),
    x2:finite(item.viewportLine.x2),y2:finite(item.viewportLine.y2)}:null,
   ellipse:item.ellipse&&typeof item.ellipse==='object'?{
    cx:finite(item.ellipse.cx),cy:finite(item.ellipse.cy),
    rx:finite(item.ellipse.rx),ry:finite(item.ellipse.ry)}:null,
   points:Array.isArray(item.viewportPoints)?item.viewportPoints.slice(0,16).map(safePoint).filter(Boolean):[]}
});
const error=(res,msg)=>{res.writeHead(400);res.end(JSON.stringify({ok:false,error:String(msg).slice(0,120)}));};
async function exactTarget(){
 const response=await fetch(endpoint+'/json/list',{signal:AbortSignal.timeout(3500)});
 if(!response.ok)throw Error('CDP_DISCOVERY_UNAVAILABLE');
 const items=await response.json();
 if(!Array.isArray(items))throw Error('INVALID_CDP_TABS');
 const tabs=items.filter(t=>t&&t.type==='page'&&typeof t.url==='string'&&t.url.startsWith(prefix));
 if(tabs.length!==1)throw Error('TASK_TAB_NOT_UNIQUE');
 return tabs[0];
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
  const taskTab=await exactTarget();
  const targetId=taskTab.id;
  if(input.op==='inspect'){
   if(Object.keys(input).some(k=>!['op','visual'].includes(k))||
      (input.visual!==undefined&&typeof input.visual!=='boolean'))throw Error('EXTRA_INSPECT_PARAMETERS');
   inspectState=null;
   const action={id:'miniwob-inspect-'+(++sequence),capability:'browser.inspect',risk:'read',
    input:{targetId,observation:{maxControls:160,maxVisuals:160,maxBytes:131072}}};
   const out=await provider.execute(action);
   if(!out.ok||out.provider!=='browser.cdp')throw Error('PROVIDER_INSPECT_FAILED_'+(out.error?.code||'UNKNOWN'));
   if(out.output?.dialog){
    const dialog=out.output.dialog;
    if(typeof dialog.ref!=='string'||!dialogRE.test(dialog.ref)||
      !new Set(['alert','confirm','prompt','beforeunload']).has(dialog.type)||
      (dialog.sourceOrigin&&!frameOrigins.includes(dialog.sourceOrigin)))
      throw Error('DIALOG_OBSERVATION_UNAUTHORIZED');
    inspectState={targetId,dialogRef:dialog.ref,dialogType:dialog.type};
    res.end(JSON.stringify({ok:true,provider:out.provider,durationMs:out.durationMs,
      dialog:{ref:dialog.ref,type:dialog.type},
      page:{semantic:{observationGeneration:'dialog-1',controls:[],visuals:[]}}}));
    return;
   }
   if(out.output?.truncated===true)throw Error('PROVIDER_OBSERVATION_TRUNCATED');
   const semantic=out.output?.page?.semantic;
   if(!semantic||typeof semantic.observationGeneration!=='string')throw Error('NO_SEMANTIC_OBSERVATION');
   if(!Array.isArray(semantic.controls)||!Array.isArray(semantic.visuals))throw Error('MISSING_OBSERVATION_ARRAYS');
   const generation=semantic.observationGeneration;
   const controls=semantic.controls.slice(0,160).map(i=>project(i,generation)),
    visuals=semantic.visuals.slice(0,160).map(i=>project(i,generation));
   let acceptedFrames=0,rejectedFrames=0;
   const frames=out.output?.page?.frames||[];
   if(Array.isArray(frames))for(const frame of frames.slice(0,16)){
    if(!frame||!frame.semantic||typeof frame.semantic.observationGeneration!=='string'||
      typeof frame.targetId!=='string'||!allowedSyntheticFrameUrl(frame.url,prefix,frameOrigins)){
     rejectedFrames++;continue;
    }
    const g=frame.semantic.observationGeneration;
    for(const item of (Array.isArray(frame.semantic.controls)?frame.semantic.controls:[]).slice(0,120))
     controls.push(project(item,g,frame.targetId));
    for(const item of (Array.isArray(frame.semantic.visuals)?frame.semantic.visuals:[]).slice(0,120))
     visuals.push(project(item,g,frame.targetId));
    acceptedFrames++;
   }
   // A genuine observed page-scroller ref is not in normal controls/visuals.
   const ps=semantic.pageScroll;
   if(ps&&typeof ps.ref==='string'&&refRE.test(ps.ref)&&ps.ref.startsWith('b-'+generation+'-')&&ps.geometry){
    visuals.unshift(project({ref:ps.ref,role:'scrollbar',tag:'div',name:'Page scroller',
     actionable:false,scrollable:true,context:{frameDepth:0,shadowDepth:0},geometry:ps.geometry},generation));
   }
   const refs=new Set(),relativeRefs=new Set(),sortableRefs=new Set(),scrollRefs=new Set(),controlInfo=new Map();
   const svgGeometry=new Set(['text','circle','ellipse','rect','path','polygon','polyline','line','canvas','img']);
   for(const item of [...controls,...visuals]){
    if(item.disabled===true||typeof item.ref!=='string')continue;
    if(!refRE.test(item.ref)||!item.ref.startsWith('b-'+item.observationGeneration+'-'))continue;
    if(!Number.isInteger(item.context.frameDepth)||item.context.frameDepth<0||item.context.frameDepth>4)continue;
    const existing=controlInfo.get(item.ref);
    if(existing&&(
      existing.sourceFrameTargetId!==item.sourceFrameTargetId||
      existing.observationGeneration!==item.observationGeneration))
      throw Error('AMBIGUOUS_OBSERVED_FRAME_REF');
    // A semantic control and a visual candidate may reference the same DOM
    // element. Keep richer actionable/editable metadata instead of overwriting.
    if(!existing||(!existing.actionable&&item.actionable))controlInfo.set(item.ref,item);
    if(item.actionable===true)refs.add(item.ref);
    else if(visuals.includes(item)&&svgGeometry.has(item.tag))relativeRefs.add(item.ref);
    if(item.scrollable===true)scrollRefs.add(item.ref);
    if(visuals.includes(item)&&item.groupRole==='li'&&
       item.semanticPath.toLowerCase().includes('sortable')&&
       new Set(['div','li','span']).has(item.tag))sortableRefs.add(item.ref);
   }
   inspectState={targetId,generation,refs,relativeRefs,sortableRefs,scrollRefs,controlInfo};
   let screenshot=null,screenshotStatus='NOT_REQUESTED';
   if(input.visual===true){
    try {screenshot=await captureSyntheticView(CdpConnection,taskTab,prefix);screenshotStatus='READY';}
    catch(e){screenshotStatus=String(e?.message||'VISUAL_CAPTURE_FAILED').slice(0,60);}
   }
   res.end(JSON.stringify({ok:true,provider:out.provider,durationMs:out.durationMs,
    textExcerpt:boundedVisiblePageText(semantic,1600),
    headings:Array.isArray(semantic.headings)?semantic.headings.filter(x=>typeof x==='string').slice(0,20):[],
    pagination:semantic.pagination||null,
    frameCoverage:out.output?.page?.frameCoverage||null,
    acceptedFrames,rejectedFrames,
    screenshotStatus,screenshot:screenshot?.data||null,
    screenshotBytes:screenshot?.bytes||0,screenshotSha256:screenshot?.digest||null,
    page:{semantic:{observationGeneration:generation,controls,visuals}},
    observedRefCount:refs.size,visualRelativeRefs:relativeRefs.size,sortableRefs:sortableRefs.size,scrollRefs:scrollRefs.size,truncated:out.output?.truncated===true}));
   return;
  }
  const allowed=new Set(['click','hover','set_value','type','select','select_date','key_press','click_relative','scroll','drag_between','drag_to','drag_by','resize','hotkey','keyboard_text','format_text','select_text_range','dialog_accept','dialog_dismiss']);
  if(!allowed.has(input.op))throw Error('UNSUPPORTED_INTERACTION');
  if(input.op==='dialog_accept'||input.op==='dialog_dismiss'){
   const ref=input.ref;
   if(!inspectState||inspectState.targetId!==targetId||
      inspectState.dialogRef!==ref||typeof ref!=='string'||!dialogRE.test(ref))
     throw Error('FRESH_DIALOG_REQUIRED');
   if(Object.keys(input).some(k=>!['op','ref','value'].includes(k)))throw Error('DIALOG_EXTRA_PARAMETERS');
   if(input.value!==undefined)validatedDialogPrompt(input.value);
   if(input.op==='dialog_dismiss'&&input.value)throw Error('DIALOG_DISMISS_VALUE_DENIED');
   if(input.value && (input.op!=='dialog_accept'||inspectState.dialogType!=='prompt'))
     throw Error('DIALOG_PROMPT_ONLY');
   inspectState=null;
   const actionInput={targetId,operation:input.op,dialogRef:ref};
   if(input.op==='dialog_accept'&&typeof input.value==='string'&&input.value.length)
     actionInput.promptText=input.value;
   const output=await provider.execute({id:'miniwob-dialog-'+(++sequence),
     capability:'browser.interact',risk:'external',input:actionInput,
     provenance:{kind:'runtime',source:'isolated-benchmark'}});
   res.end(JSON.stringify({ok:output.ok===true,provider:output.provider,
     durationMs:output.durationMs,error:output.error?.code||null,
     sideEffectState:output.error?.details?.sideEffectState||null,
     executionPhase:output.error?.details?.executionPhase||null,
     stateProgress:output.ok===true,needsReobserve:true}));
   return;
  }
  if(!inspectState||inspectState.targetId!==targetId)throw Error('FRESH_INSPECTION_REQUIRED');
  const ref=input.ref;
  if(typeof ref!=='string'||!refRE.test(ref))throw Error('BAD_REF_FORMAT');
  const graphicalRefs=new Set([...inspectState.refs,...inspectState.relativeRefs]);
  const allowedRefs=(input.op==='click_relative'?inspectState.relativeRefs:
    input.op==='drag_between'?inspectState.sortableRefs:
    input.op==='drag_to'||input.op==='hover'||input.op==='drag_by'||input.op==='resize'?graphicalRefs:
    input.op==='scroll'?inspectState.scrollRefs:inspectState.refs);
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
  const dispatchOp=providerOperationForInput(input.op==='drag_to'?'drag_between':input.op,observed?.role);
  const actionInput={targetId,operation:dispatchOp,target:{ref}};
  if(input.op==='click_relative'){Object.assign(actionInput,boundedRelativePoint(input.value));}
  if(['type','set_value','select','select_date','keyboard_text','format_text','select_text_range'].includes(input.op)){
   if(typeof input.value!=='string'||(input.value.length===0&&input.op!=='set_value')||input.value.length>400)throw Error('INVALID_TEXT_VALUE');
   if(input.op==='select_date'&&!/^\d{4}-\d{2}-\d{2}$/.test(input.value))throw Error('DATE_VALUE_INVALID');
   actionInput.value=input.value;
  }
  if(input.op==='scroll'){
   Object.assign(actionInput,boundedScrollDelta(input.value));
  }
  if(input.op==='drag_by'||input.op==='resize'){
   const {deltaX,deltaY}=boundedDisplacement(input.value);
   actionInput.deltaX=deltaX;
   actionInput.deltaY=deltaY;
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
  if(input.op==='drag_between'||input.op==='drag_to'){
   const sourceFrame=inspectState.controlInfo.get(ref)?.sourceFrameTargetId||'';
   const toRef=input.value;
   if((inspectState.controlInfo.get(toRef)?.sourceFrameTargetId||'')!==sourceFrame)throw Error('CROSS_FRAME_DRAG_DENIED');
   if(typeof toRef!=='string'||!refRE.test(toRef)||toRef===ref||
      !(input.op==='drag_to'?graphicalRefs.has(toRef):inspectState.sortableRefs.has(toRef))||
      toRef.slice(0,toRef.lastIndexOf('-'))!==ref.slice(0,ref.lastIndexOf('-')))
       throw Error('DRAG_TARGETS_NOT_CURRENT');
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
