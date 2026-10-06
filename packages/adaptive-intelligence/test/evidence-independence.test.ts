import assert from 'node:assert/strict';
import test from 'node:test';
import { EpistemicStateEngine, detectPerceptionConflicts } from '../src/index.ts';

const A='a'.repeat(64),B='b'.repeat(64),C='c'.repeat(64),D='d'.repeat(64);
const T0='2026-10-05T00:00:00.000Z';

test('repeated correlated support cannot multiply epistemic confidence',()=>{
  const engine=new EpistemicStateEngine({clock:()=>new Date(T0)});
  for(let i=0;i<10;i+=1){
    const digest=(i%2===0?A:B);
    engine.observe({
      factKey:'target.enabled',
      valueDigest:C,
      polarity:'supports',
      confidence:0.7,
      evidence:{
        digest,
        source:'same-render-pipeline',
        channel:'visual',
        observedAt:T0,
        independenceKey:'capture-1'
      }
    });
  }
  const resolved=engine.resolve('target.enabled');
  assert.ok(Math.abs(resolved.confidence-0.7)<1e-12);
  assert.equal(resolved.status,'SUPPORTED');
});

test('genuinely independent support may increase confidence',()=>{
  const engine=new EpistemicStateEngine({clock:()=>new Date(T0)});
  engine.observe({
    factKey:'target.enabled',
    valueDigest:C,
    polarity:'supports',
    confidence:0.7,
    evidence:{
      digest:A,
      source:'dom-provider',
      channel:'dom',
      observedAt:T0,
      independenceKey:'dom-snapshot-1'
    }
  });
  engine.observe({
    factKey:'target.enabled',
    valueDigest:C,
    polarity:'supports',
    confidence:0.7,
    evidence:{
      digest:B,
      source:'uia-provider',
      channel:'uia',
      observedAt:T0,
      independenceKey:'uia-snapshot-1'
    }
  });
  const resolved=engine.resolve('target.enabled');
  assert.ok(resolved.confidence>0.9);
  assert.equal(resolved.status,'KNOWN');
});

test('correlated contradictory perception from one capture does not fake cross-channel conflict',()=>{
  const conflicts=detectPerceptionConflicts([
    {
      factKey:'button.visible',
      valueDigest:A,
      channel:'visual',
      confidence:0.9,
      evidence:{
        digest:C,
        source:'shared-capture',
        channel:'visual',
        observedAt:T0,
        independenceKey:'capture-1'
      }
    },
    {
      factKey:'button.visible',
      valueDigest:B,
      channel:'application',
      confidence:0.85,
      evidence:{
        digest:D,
        source:'derived-from-shared-capture',
        channel:'application',
        observedAt:T0,
        independenceKey:'capture-1'
      }
    }
  ]);
  assert.equal(conflicts.length,0);
});

test('independent contradictory channels still surface conflict',()=>{
  const conflicts=detectPerceptionConflicts([
    {
      factKey:'button.visible',
      valueDigest:A,
      channel:'dom',
      confidence:0.9,
      evidence:{
        digest:C,
        source:'dom-provider',
        channel:'dom',
        observedAt:T0,
        independenceKey:'dom-1'
      }
    },
    {
      factKey:'button.visible',
      valueDigest:B,
      channel:'uia',
      confidence:0.9,
      evidence:{
        digest:D,
        source:'uia-provider',
        channel:'uia',
        observedAt:T0,
        independenceKey:'uia-1'
      }
    }
  ]);
  assert.equal(conflicts.length,1);
  assert.ok((conflicts[0]?.severity??0)>0.5);
});
