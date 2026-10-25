import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { createTask } from '../src/core/task.ts';
import { verifyGoalOutcomeTruth } from '../src/core/task-verifier.ts';

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const T = (millis:number)=>new Date(Date.UTC(2026,9,25)+millis).toISOString();

function navigationFixture(observedAt: string) {
  return createTask({
    userObjective: 'Navigate to the requested scoped page',
    interpretedObjective: 'Navigate only to the approved page',
    authorizedScope: ['https://example.test'], prohibitedScope: [],
    successConditions: ['page destination verified'],
    execution: {
      schemaVersion:1, plannerId:'operator.semantic.v1', goalKind:'browser-navigation',
      plannerState:{phase:'complete',goal:{kind:'browser-navigation',url:'https://example.test/checkout'}},
      maxSteps:4,maxAttemptsPerStep:1,timeoutMs:10000,stepCount:1,
      records:[{
        stepKey:'verify-browser',actionId:'a1',capability:'browser.inspect',risk:'read',
        inputHash:'a'.repeat(64),attempt:1,state:'SUCCEEDED',
        startedAt:T(200),finishedAt:T(400),evidence:[],
        observation:{
          schemaVersion:2,domain:'browser',channel:'semantic',provider:'test',
          capability:'browser.inspect',entityId:'tab-1',observedAt,
          stateVersion:sha256('fresh-tab-1'),importantState:{
            browserTargets:[{type:'page',id:'tab-1',
              destinationDigest:sha256('https://example.test/checkout')}]
          },
          epistemicStatus:'KNOWN',epistemicReason:'',ambiguous:false,
          confidence:1,evidenceRefs:['b'.repeat(64)]
        }
      }]
    }
  });
}

test('C07 success-looking browser destination from before verification action is not fresh proof',()=>{
  const task=navigationFixture(T(150));
  const result=verifyGoalOutcomeTruth(task);
  assert.equal(result.supported,true);
  assert.equal(result.ok,false);
});

test('C07 browser destination observed after current verification action can prove typed navigation',()=>{
  const task=navigationFixture(T(250));
  assert.equal(verifyGoalOutcomeTruth(task).ok,true);
});

test('C07 later failed verification supersedes earlier valid destination proof',()=>{
  const task=navigationFixture(T(250));
  task.execution!.records.push({
    ...task.execution!.records[0]!,
    actionId:'a2',attempt:2,startedAt:T(500),finishedAt:T(600),state:'FAILED',
    observation:undefined,evidence:[]
  });
  assert.equal(verifyGoalOutcomeTruth(task).ok,false);
});
