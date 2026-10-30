// Pure operation translation, independent of CDP, network or benchmark state.
export function providerOperationForInput(op, observedRole) {
  if(op==='set_value' && observedRole!=='slider') return 'type';
  return op;
}

export function boundedScrollDelta(value) {
 const m=/^(up|down|left|right)(?::(40|80|160|320|640))?$/.exec(value);
 if(!m)throw new Error('INVALID_SCROLL_DIRECTION');
 const d=Number(m[2]||80);
 return {deltaX:m[1]==='left'?-d:m[1]==='right'?d:0,
         deltaY:m[1]==='up'?-d:m[1]==='down'?d:0};
}

export function boundedDisplacement(value) {
 const m=/^(left|right|up|down|up-left|up-right|down-left|down-right):(10|20|40|80|160|320)$/.exec(value);
 if(!m)throw new Error('INVALID_DISPLACEMENT');
 const d=Number(m[2]);const direction=m[1];
 return {deltaX:direction.includes('left')?-d:direction.includes('right')?d:0,
         deltaY:direction.includes('up')?-d:direction.includes('down')?d:0};
}

// Model chooses one of nine bounded positions within an observed element.
// CDP provider independently hit-tests the resulting point before dispatch.
export function relativePointForLabel(label) {
 const points={center:[0.5,0.5],left:[0.15,0.5],right:[0.85,0.5],
  top:[0.5,0.15],bottom:[0.5,0.85],
  'top-left':[0.15,0.15],'top-right':[0.85,0.15],
  'bottom-left':[0.15,0.85],'bottom-right':[0.85,0.85]};
 if(label===''||label===undefined)label='center';
 if(!Object.hasOwn(points,label))throw Error('INVALID_RELATIVE_POINT');
 return {xRatio:points[label][0],yRatio:points[label][1]};
}

// Bounded ratios are always inside a current observed element; the CDP provider
// performs its own pointer hit-test. There is no unrestricted screen click.
export function boundedRelativePoint(value){
 if(typeof value!=='string')throw new Error('INVALID_RELATIVE_POINT');
 if(/^(?:0\.[0-9]{1,2}|1(?:\.0{1,2})?|0):(?:0\.[0-9]{1,2}|1(?:\.0{1,2})?|0)$/.test(value)){
  const [xRatio,yRatio]=value.split(':').map(Number);
  return {xRatio,yRatio};
 }
 return relativePointForLabel(value);
}


/** Retain provider-observed visible page instructions; never read DOM or hidden text here. */
export function boundedVisiblePageText(semantic, maxLength=1600) {
  if (!semantic || typeof semantic !== 'object') return '';
  const rows = Array.isArray(semantic.visibleText) ? semantic.visibleText : [];
  const pieces=[];
  let remaining=Math.min(1600,Math.max(0,Math.floor(maxLength)));
  for (const row of rows.slice(0,120)) {
    const value=typeof row==='string'?row:row&&typeof row.text==='string'?row.text:'';
    const normalized=value.replace(/\s+/g,' ').trim();
    if (!normalized || remaining<=0) continue;
    const piece=normalized.slice(0,Math.min(remaining,240));
    pieces.push(piece);
    remaining-=piece.length+1;
  }
  const result=pieces.join(' ');
  return result || (typeof semantic.textExcerpt==='string' ? semantic.textExcerpt.slice(0,Math.min(1600,Math.max(0,Math.floor(maxLength)))) : '');
}


/** Prompt text is never allowed to carry a NUL or oversized payload. */
export function validatedDialogPrompt(value) {
  if (typeof value!=='string' || value.length>400 || value.includes('\0'))
    throw new Error('DIALOG_PROMPT_INVALID');
  return value;
}


/** A validation-only rejection is proven to have no browser side effect. */
export function preDispatchRejection(message) {
  return {ok:false,error:String(message).slice(0,120),
    sideEffectState:'none',executionPhase:'pre_dispatch'};
}

/** Closed, ref-relative gesture alphabet; never viewport or CSS coordinates.
 * Values are 2-24 semicolon-separated pairs quantized to hundredths.
 * Every point is subsequently verified by the native Mecord provider.
 */
export function boundedGesturePath(value) {
  if(typeof value!=='string'||value.length>300)throw Error('INVALID_GESTURE_PATH');
  const pieces=value.split(';');
  if(pieces.length<2||pieces.length>24)throw Error('INVALID_GESTURE_PATH');
  const path=pieces.map(piece=>{
    if(!/^(?:0\\.[0-9]{1,2}|1(?:\\.00?)?):(?:0\\.[0-9]{1,2}|1(?:\\.00?)?)$/.test(piece))
      throw Error('INVALID_GESTURE_PATH');
    const [xRatio,yRatio]=piece.split(':').map(Number);
    if(xRatio<0.01||xRatio>0.99||yRatio<0.01||yRatio>0.99)
      throw Error('INVALID_GESTURE_PATH');
    return {xRatio,yRatio};
  });
  if(path.every(p=>p.xRatio===path[0].xRatio&&p.yRatio===path[0].yRatio))
    throw Error('INVALID_GESTURE_PATH');
  return path;
}
