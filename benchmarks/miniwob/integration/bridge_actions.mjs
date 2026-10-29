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
