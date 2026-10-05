import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EpistemicStateEngine,
  detectPerceptionConflicts
} from '../src/index.ts';

const A='a'.repeat(64),B='b'.repeat(64),C='c'.repeat(64);
const T0='2026-10-05T00:00:00.000Z';

test('markUnobservable rejects secret-bearing fact keys',()=>{
  const engine=new EpistemicStateEngine({clock:()=>new Date(T0)});
  assert.throws(()=>engine.markUnobservable('api_token'),/Secret-bearing/);
  assert.throws(()=>engine.clearUnobservable('private_key'),/Secret-bearing/);
});

test('live epistemic observation rejects future-dated evidence',()=>{
  const engine=new EpistemicStateEngine({clock:()=>new Date(T0)});
  assert.throws(()=>engine.observe({
    factKey:'target.visible',
    valueDigest:A,
    polarity:'supports',
    confidence:0.8,
    evidence:{
      digest:B,
      source:'future-source',
      observedAt:'2026-10-05T00:00:01.000Z'
    }
  }),/future-dated/);
});

test('epistemic restart rejects future insertion and evidence that postdates insertion',()=>{
  assert.throws(()=>EpistemicStateEngine.fromState({
    claims:[{
      factKey:'target.visible',
      valueDigest:A,
      polarity:'supports',
      confidence:0.8,
      evidence:{digest:B,source:'source',observedAt:T0},
      insertedAt:'2026-10-05T00:00:01.000Z'
    }],
    unobservable:[]
  },{clock:()=>new Date(T0)}),/future-inserted/);

  assert.throws(()=>EpistemicStateEngine.fromState({
    claims:[{
      factKey:'target.visible',
      valueDigest:A,
      polarity:'supports',
      confidence:0.8,
      evidence:{digest:B,source:'source',observedAt:'2026-10-05T00:00:01.000Z'},
      insertedAt:T0
    }],
    unobservable:[]
  },{clock:()=>new Date('2026-10-05T00:00:02.000Z')}),/postdate its insertion/);
});

test('same epistemic evidence digest cannot be rebound to conflicting metadata',()=>{
  const engine=new EpistemicStateEngine({clock:()=>new Date(T0)});
  engine.observe({
    factKey:'target.visible',
    valueDigest:A,
    polarity:'supports',
    confidence:0.7,
    evidence:{
      digest:B,
      source:'dom',
      channel:'dom',
      independenceKey:'dom-1',
      observedAt:T0
    }
  });
  assert.throws(()=>engine.observe({
    factKey:'target.visible',
    valueDigest:A,
    polarity:'supports',
    confidence:0.9,
    evidence:{
      digest:B,
      source:'visual',
      channel:'visual',
      independenceKey:'visual-1',
      observedAt:T0
    }
  }),/Conflicting epistemic evidence metadata/);
});

test('perception claim channel must match evidence channel',()=>{
  assert.throws(()=>detectPerceptionConflicts([{
    factKey:'target.visible',
    valueDigest:A,
    channel:'uia',
    confidence:0.9,
    evidence:{
      digest:B,
      source:'visual-provider',
      channel:'visual',
      observedAt:T0
    }
  }]),/channel must match evidence channel/);
});

test('correlationKey cannot override a conflicting evidence independence key',()=>{
  assert.throws(()=>detectPerceptionConflicts([{
    factKey:'target.visible',
    valueDigest:A,
    channel:'visual',
    confidence:0.9,
    correlationKey:'fake-independent-bucket',
    evidence:{
      digest:B,
      source:'capture',
      channel:'visual',
      independenceKey:'real-capture-bucket',
      observedAt:T0
    }
  }]),/correlationKey conflicts/);
});

test('perception evidence is validated rather than blindly cloned',()=>{
  assert.throws(()=>detectPerceptionConflicts([{
    factKey:'target.visible',
    valueDigest:A,
    channel:'dom',
    confidence:0.9,
    evidence:{
      digest:'bad-digest',
      source:'dom',
      channel:'dom',
      observedAt:T0
    }
  }]),/SHA-256/);
});

test('same perception evidence digest with conflicting metadata is rejected',()=>{
  assert.throws(()=>detectPerceptionConflicts([
    {
      factKey:'target.state',
      valueDigest:A,
      channel:'dom',
      confidence:0.9,
      evidence:{
        digest:B,
        source:'dom-a',
        channel:'dom',
        independenceKey:'dom-a',
        observedAt:T0
      }
    },
    {
      factKey:'target.state',
      valueDigest:C,
      channel:'uia',
      confidence:0.9,
      evidence:{
        digest:B,
        source:'uia-b',
        channel:'uia',
        independenceKey:'uia-b',
        observedAt:T0
      }
    }
  ]),/Conflicting perception evidence metadata/);
});
