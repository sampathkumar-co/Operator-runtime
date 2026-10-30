import test from 'node:test';
import assert from 'node:assert/strict';
import {parseNativeGesturePath,NATIVE_GESTURE_OPS} from './native_graphical.mjs';
test('bounded native graphical path remains fully contained inside observed graphic',()=>{
 assert.deepEqual(parseNativeGesturePath('0.20:0.30;0.40:0.50;0.80:0.70'),
  [{xRatio:0.2,yRatio:0.3},{xRatio:0.4,yRatio:0.5},{xRatio:0.8,yRatio:0.7}]);
 assert.deepEqual([...NATIVE_GESTURE_OPS],['double_click','shift_click','drag_path']);
});
test('reject point forgery and zero-distance gesture',()=>{
 for(const value of ['0.00:0.2;0.9:0.9','1.0:0.5;0.5:0.5','0.9:0.9;0.9:0.9',
  '0.12:0.12','0.333:0.4;0.4:0.6','0.3,0.3;0.8,0.8','0.20:0.20;0.20:0.20']){
  assert.throws(()=>parseNativeGesturePath(value),/NATIVE_PATH/);
 }
});
