// Pure operation translation, independent of CDP, network or benchmark state.
export function providerOperationForInput(op, observedRole) {
  if(op==='set_value' && observedRole!=='slider') return 'type';
  return op;
}

export function boundedScrollDelta(value) {
  const match=/^(up|down)(?::(80|160|320))?$/.exec(value);
  if(!match) throw new Error('INVALID_SCROLL_DIRECTION');
  return (match[1]==='up'?-1:1)*Number(match[2]||80);
}

export function boundedDisplacement(value) {
  const match=/^(left|right|up|down):(40|80|160)$/.exec(value);
  if(!match) throw new Error('INVALID_DISPLACEMENT');
  const d=Number(match[2]);
  return {deltaX:match[1]==='left'?-d:match[1]==='right'?d:0,
          deltaY:match[1]==='up'?-d:match[1]==='down'?d:0};
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
