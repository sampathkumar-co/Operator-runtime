// Source-only native gesture parser. No arbitrary viewport coordinates.
export const NATIVE_GESTURE_OPS = Object.freeze(['double_click','shift_click','drag_path']);
export function parseNativeGesturePath(value) {
 if (typeof value!=='string' || value.length>400 || !value) throw Error('NATIVE_PATH_INVALID');
 const chunks=value.split(';');
 if(chunks.length<2||chunks.length>24)throw Error('NATIVE_PATH_COUNT_INVALID');
 const points=chunks.map(chunk=>{
  const m=/^(0\.(?:0[1-9]|[1-9][0-9]?)|0\.99):(0\.(?:0[1-9]|[1-9][0-9]?)|0\.99)$/.exec(chunk);
  if(!m)throw Error('NATIVE_PATH_POINT_INVALID');
  return {xRatio:Number(m[1]),yRatio:Number(m[2])};
 });
 if(points.every(p=>p.xRatio===points[0].xRatio&&p.yRatio===points[0].yRatio))
  throw Error('NATIVE_PATH_NO_MOVEMENT');
 return points;
}
