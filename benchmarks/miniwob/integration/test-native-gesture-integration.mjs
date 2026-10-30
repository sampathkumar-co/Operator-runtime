import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {boundedGesturePath} from './bridge_actions.mjs';
import {verifyIsolatedRuntimePin,LEGACY_VERSION,LEGACY_COMMIT} from './runtime_pin.mjs';

test('exact legacy RC6 pin never advertises newer native gestures',()=>{
  const got=verifyIsolatedRuntimePin({version:LEGACY_VERSION,sourceCommit:LEGACY_COMMIT},
    Buffer.from('{}'),{});
  assert.equal(got.nativeGesturesEnabled,false);
  assert.throws(()=>verifyIsolatedRuntimePin({version:'2.0.7-rc.7',sourceCommit:'f'.repeat(40)},
    Buffer.from('{}'),{}),/UNPINNED_RUNTIME/);
});
test('new candidate requires exact independently supplied manifest digest and opt-in',()=>{
  const sourceCommit='f'.repeat(40);
  const manifest=JSON.stringify({version:'2.0.7-rc.7',sourceCommit});
  const bytes=Buffer.from(manifest);
  const digest=createHash('sha256').update(bytes).digest('hex');
  const env={MECORD_MINIWOB_NATIVE_GESTURES:'1',MECORD_MINIWOB_EXPECTED_RUNTIME_VERSION:'2.0.7-rc.7',
    MECORD_MINIWOB_EXPECTED_RUNTIME_COMMIT:sourceCommit,MECORD_MINIWOB_EXPECTED_MANIFEST_SHA256:digest};
  assert.equal(verifyIsolatedRuntimePin(JSON.parse(manifest),bytes,env).nativeGesturesEnabled,true);
  for(const mutation of [
    {...env,MECORD_MINIWOB_EXPECTED_MANIFEST_SHA256:'0'.repeat(64)},
    {...env,MECORD_MINIWOB_EXPECTED_RUNTIME_COMMIT:'e'.repeat(40)},
    {...env,MECORD_MINIWOB_EXPECTED_RUNTIME_VERSION:'2.0.7-rc.8'},
    {...env,MECORD_MINIWOB_NATIVE_GESTURES:'0'},
  ]){
    assert.throws(()=>verifyIsolatedRuntimePin(JSON.parse(manifest),bytes,mutation));
  }
});
test('native gesture paths stay inside observed element and are quantized',()=>{
  assert.deepEqual(boundedGesturePath('0.10:0.15;0.90:0.85'),[
    {xRatio:.1,yRatio:.15},{xRatio:.9,yRatio:.85}]);
  for(const malformed of ['','0.20:0.20','0.00:0.20;0.90:0.90',
    '0.10:0.10;1.00:0.90','0.10:0.10;0.10:0.10',
    '0.30:0.40;0.333:0.40','0.30:0.40;0.40:0.5;'.repeat(20),
    '0.1:0.1;0.2:0.2;eval(1)',null,42]){
    assert.throws(()=>boundedGesturePath(malformed),/INVALID_GESTURE_PATH/);
  }
});
