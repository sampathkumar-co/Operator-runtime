import assert from 'node:assert/strict';
import test from 'node:test';
import { assertManagedComposeIdentity } from '../src/capabilities/docker.ts';

test('C06 managed Compose identities remain stable across service order changes',()=>{
  assert.doesNotThrow(()=>assertManagedComposeIdentity(
    ['a'.repeat(64),'b'.repeat(64)],['api','worker'],[
      {id:'b'.repeat(64),service:'worker'},
      {id:'a'.repeat(64),service:'api'},
      {id:'c'.repeat(64),service:'unrelated'}
    ]
  ));
});

test('C06 replacement, disappearance or injection of managed containers prevents false verified lifecycle success',()=>{
  const a='a'.repeat(64),b='b'.repeat(64),c='c'.repeat(64);
  for(const observed of [
    [],
    [{id:b,service:'api'}],
    [{id:a,service:'api'},{id:b,service:'api'}],
    [{id:a,service:'worker'}],
    [{id:c,service:'api'}],
    [{id:a,service:'api'},{id:c,service:'api'}]
  ]) {
    assert.throws(()=>assertManagedComposeIdentity([a],['api'],observed),
      (error:any)=>error?.code==='DOCKER_CONTAINER_IDENTITY_CHANGED' &&
        error?.details?.sideEffectState==='uncertain' &&
        error?.details?.executionPhase==='effect_observed');
  }
  assert.throws(()=>assertManagedComposeIdentity([],['api'],[]),
    (error:any)=>error?.code==='DOCKER_CONTAINER_IDENTITY_CHANGED');
});
