import assert from 'node:assert/strict';
import test from 'node:test';
import { BoundedModelGoalInference } from '../src/core/bounded-model-goal-inference.ts';
import { TrustedReviewedModelTaskIntake } from '../src/core/trusted-reviewed-model-task-intake.ts';

const scope = {
  objective: 'Open the explicitly approved page',
  approvedBrowserOrigins: ['https://allowed.example'],
  approvedRoots: []
};
const modelResponse = {
  goal: { kind: 'browser-navigation', url: 'https://allowed.example/help' },
  successConditions: ['Freshly observe the approved page after navigation']
};
function fixture() {
  let currentScope: typeof scope | null = scope;
  let principal = 'authenticated-local-owner';
  let nativeProof = 'native-approved-session-review';
  let submitted = 0, models = 0, reservations = 0, finalizations = 0;
  let submitError: Error | undefined;
  const model = new BoundedModelGoalInference({
    modelId: 'injected-model', maxOutputTokens: 256, maxCostMicros: 0, timeoutMs: 1500,
    ledger: {
      async reserve() { reservations++; return { reservationId: 'persisted' }; },
      async finalize() { finalizations++; }
    },
    generator: {
      async generate() { models++; return { text: JSON.stringify(modelResponse) }; }
    }
  });
  const intake = new TrustedReviewedModelTaskIntake({
    model, authority: {
      async currentApprovedScope(supplied) {
        return supplied === principal ? currentScope : null;
      },
      async verifyTrustedReview(input) {
        return input.principal === principal && input.reviewProof === nativeProof;
      },
      async submitReviewedTask(options) {
        submitted++;
        assert.equal(options.goal.kind, 'browser-navigation');
        assert.deepEqual(options.successConditions, modelResponse.successConditions);
        if (submitError) throw submitError;
        return { id: 'durable-task-' + submitted, executionStarted: false as const };
      }
    }
  });
  return {intake,
    get models(){return models;}, get reservations(){return reservations;},
    get finalizations(){return finalizations;}, get submitted(){return submitted;},
    revoke:()=>{currentScope=null;},
    setObjective:(objective:string)=>{currentScope={...scope,objective};},
    setSubmitError:(error:Error|undefined)=>{submitError=error;},
    principal,nativeProof};
}

test('C05 source-level inference proposal requires current exact scope then native proof and one-use task submission',async()=>{
  const f=fixture();
  const proposed=await f.intake.propose({
    principal:f.principal,request:scope,allowModelTransmission:true
  });
  assert.equal(proposed.executionStarted,false);
  assert.deepEqual(proposed.proposal,modelResponse);
  assert.equal(f.reservations,1);
  assert.equal(f.models,1);
  assert.equal(f.finalizations,1);
  assert.equal(f.submitted,0);
  const confirmed=await f.intake.confirm({
    principal:f.principal,proposalId:proposed.proposalId,
    proposalDigest:proposed.proposalDigest,reviewProof:f.nativeProof
  });
  assert.deepEqual(confirmed,{taskId:'durable-task-1',executionStarted:false});
  assert.equal(f.submitted,1);
  await assert.rejects(f.intake.confirm({
    principal:f.principal,proposalId:proposed.proposalId,
    proposalDigest:proposed.proposalDigest,reviewProof:f.nativeProof
  }),(error:any)=>error.code==='TASK_PROPOSAL_REVIEW_INVALID');
  assert.equal(f.submitted,1);
});
test('C05 no user-declared boolean or wrong principal bypasses actual native reviewer',async()=>{
  const f=fixture();
  await assert.rejects(f.intake.propose({
    principal:f.principal,request:scope,allowModelTransmission:false as never
  }),(error:any)=>error.code==='TASK_MODEL_TRANSMISSION_DENIED');
  await assert.rejects(f.intake.propose({
    principal:'other-user',request:scope,allowModelTransmission:true
  }),(error:any)=>error.code==='TASK_MODEL_INTAKE_SCOPE_DENIED');
  assert.equal(f.models,0);
  const p=await f.intake.propose({
    principal:f.principal,request:scope,allowModelTransmission:true
  });
  await assert.rejects(f.intake.confirm({
    principal:f.principal,proposalId:p.proposalId,
    proposalDigest:p.proposalDigest,reviewProof:true
  }),(error:any)=>error.code==='TASK_MODEL_REVIEW_DENIED');
  await assert.rejects(f.intake.confirm({
    principal:'other-user',proposalId:p.proposalId,
    proposalDigest:p.proposalDigest,reviewProof:f.nativeProof
  }),(error:any)=>error.code==='TASK_MODEL_REVIEW_DENIED');
  assert.equal(f.submitted,0);
});
test('C05 revoked or changed scope invalidates one-use review without dispatch',async()=>{
  const f=fixture();
  const p=await f.intake.propose({principal:f.principal,request:scope,allowModelTransmission:true});
  f.revoke();
  await assert.rejects(f.intake.confirm({
    principal:f.principal,proposalId:p.proposalId,
    proposalDigest:p.proposalDigest,reviewProof:f.nativeProof
  }),(error:any)=>error.code==='TASK_PROPOSAL_SCOPE_DENIED');
  assert.equal(f.submitted,0);
});
test('C05 model scope must match trusted runtime before any transport or cost reservation',async()=>{
  const f=fixture();
  await assert.rejects(f.intake.propose({
    principal:f.principal,
    request:{...scope,approvedBrowserOrigins:['https://evil.example']},
    allowModelTransmission:true
  }),(error:any)=>error.code==='TASK_MODEL_INTAKE_SCOPE_DENIED');
  f.setObjective('Objective changed');
  await assert.rejects(f.intake.propose({
    principal:f.principal,request:scope,allowModelTransmission:true
  }),(error:any)=>error.code==='TASK_MODEL_INTAKE_SCOPE_DENIED');
  assert.equal(f.reservations,0);
  assert.equal(f.models,0);
});
test('C05 task submit failure burns confirmation and never retries uncertain side effects',async()=>{
  const f=fixture();
  const p=await f.intake.propose({principal:f.principal,request:scope,allowModelTransmission:true});
  f.setSubmitError(new Error('durable task store failed'));
  const proof={
    principal:f.principal,proposalId:p.proposalId,
    proposalDigest:p.proposalDigest,reviewProof:f.nativeProof
  };
  await assert.rejects(f.intake.confirm(proof),/durable task store failed/);
  f.setSubmitError(undefined);
  await assert.rejects(f.intake.confirm(proof),
    (error:any)=>error.code==='TASK_PROPOSAL_REVIEW_INVALID');
  assert.equal(f.submitted,1);
});
test('C05 parallel confirmation cannot produce two task submissions',async()=>{
  const f=fixture();
  const p=await f.intake.propose({principal:f.principal,request:scope,allowModelTransmission:true});
  const review={principal:f.principal,proposalId:p.proposalId,
    proposalDigest:p.proposalDigest,reviewProof:f.nativeProof};
  const results=await Promise.allSettled([f.intake.confirm(review),f.intake.confirm(review)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(results.filter(r=>r.status==='rejected').length,1);
  assert.equal(f.submitted,1);
});
test('C05 mandatory authority callbacks fail closed before model invocation',()=>{
  assert.throws(()=>new TrustedReviewedModelTaskIntake({
    model:undefined as never,authority:undefined as never
  }),(error:any)=>error.code==='TASK_MODEL_INTAKE_AUTH_INVALID');
});


test('C05 revoke during slow model request prevents issuing even a stale approval review',async()=>{
  let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  let current = true, transmitted = 0;
  const model = new BoundedModelGoalInference({
    modelId:'test-local-model',maxOutputTokens:256,maxCostMicros:0,timeoutMs:1000,
    ledger:{
      async reserve(){return {reservationId:'reserved'};},
      async finalize(){}
    },generator:{async generate(){
      transmitted++;
      await gate;
      return {text:JSON.stringify(modelResponse)};
    }}
  });
  const intake=new TrustedReviewedModelTaskIntake({model,authority:{
    async currentApprovedScope(){return current?scope:null;},
    async verifyTrustedReview(){return true;},
    async submitReviewedTask(){throw Error('must never submit');}
  }});
  const attempt=intake.propose({
    principal:'auth-owner',request:scope,allowModelTransmission:true
  });
  await new Promise(resolve=>setImmediate(resolve));
  current=false;
  release();
  await assert.rejects(attempt,(error:any)=>error.code==='TASK_MODEL_INTAKE_SCOPE_DENIED');
  assert.equal(transmitted,1);
});
test('C05 queued-only callback rejects a task that was already started', async()=>{
  const f=fixture();
  const model=new BoundedModelGoalInference({
    modelId:'test-model',maxOutputTokens:256,maxCostMicros:0,timeoutMs:1000,
    ledger:{async reserve(){return {reservationId:'reserved'};},async finalize(){}},
    generator:{async generate(){return {text:JSON.stringify(modelResponse)}}}
  });
  const intake=new TrustedReviewedModelTaskIntake({model,authority:{
    async currentApprovedScope(){return scope;},
    async verifyTrustedReview(){return true;},
    async submitReviewedTask(){return {id:'started-task',executionStarted:true as never};}
  }});
  const review=await intake.propose({principal:f.principal,request:scope,allowModelTransmission:true});
  const confirmation={principal:f.principal,proposalId:review.proposalId,
    proposalDigest:review.proposalDigest,reviewProof:'test-owner-proof'};
  await assert.rejects(intake.confirm(confirmation),
    (error:any)=>error.code==='TASK_MODEL_SUBMIT_NOT_CONFIRMED');
  await assert.rejects(intake.confirm(confirmation),
    (error:any)=>error.code==='TASK_PROPOSAL_REVIEW_INVALID');
});

test('C05 asynchronous native review cannot submit after the trusted Stop signal aborts', async () => {
  let finishNative!: () => void;
  const nativeGate = new Promise<void>(resolve => { finishNative = resolve; });
  let submitted = 0, reviewStarted!: () => void;
  const reviewEntered = new Promise<void>(resolve => { reviewStarted = resolve; });
  const model = new BoundedModelGoalInference({
    modelId: 'fake-model', maxOutputTokens: 256, maxCostMicros: 0, timeoutMs: 1500,
    ledger: {
      async reserve() { return { reservationId: 'synthetic-reserved' }; },
      async finalize() {}
    },
    generator: { async generate() { return { text: JSON.stringify(modelResponse) }; } }
  });
  const intake = new TrustedReviewedModelTaskIntake({
    model, authority: {
      async currentApprovedScope() { return scope; },
      async verifyTrustedReview() {
        reviewStarted();
        await nativeGate;
        return true;
      },
      async submitReviewedTask() {
        submitted++;
        return { id: 'should-never-exist', executionStarted: false as const };
      }
    }
  });
  const p = await intake.propose({
    principal: 'authenticated-local-owner', request: scope, allowModelTransmission: true
  });
  const stop = new AbortController();
  const pending = intake.confirm({
    principal: 'authenticated-local-owner', proposalId: p.proposalId,
    proposalDigest: p.proposalDigest, reviewProof: 'native-proof',
    signal: stop.signal
  });
  await reviewEntered;
  stop.abort('EMERGENCY_STOPPED');
  finishNative();
  await assert.rejects(pending, (error: any) => error?.code === 'TASK_MODEL_REVIEW_DENIED');
  assert.equal(submitted, 0);
  await assert.rejects(intake.confirm({
    principal: 'authenticated-local-owner', proposalId: p.proposalId,
    proposalDigest: p.proposalDigest, reviewProof: 'native-proof',
    signal: stop.signal
  }), (error: any) => error?.code === 'TASK_MODEL_REVIEW_DENIED');
});

test('C05 native confirmation accepts only literal boolean true, never truthy provider output', async () => {
  let nativeResult: unknown = 'true';
  let submits = 0;
  const model = new BoundedModelGoalInference({
    modelId: 'fake-model', maxOutputTokens: 256, maxCostMicros: 0, timeoutMs: 1000,
    ledger: { async reserve() { return { reservationId: 'reserved' }; }, async finalize() {} },
    generator: { async generate() { return { text: JSON.stringify(modelResponse) }; } }
  });
  const intake = new TrustedReviewedModelTaskIntake({
    model, authority: {
      async currentApprovedScope() { return scope; },
      async verifyTrustedReview() { return nativeResult as boolean; },
      async submitReviewedTask() {
        submits++;
        return { id: 'queued-task', executionStarted: false as const };
      }
    }
  });
  const p = await intake.propose({
    principal: 'auth-owner', request: scope, allowModelTransmission: true
  });
  const review = {
    principal: 'auth-owner', proposalId: p.proposalId,
    proposalDigest: p.proposalDigest, reviewProof: 'native-proof'
  };
  for (const invalid of ['true', 1, {}, [], null, undefined]) {
    nativeResult = invalid;
    await assert.rejects(intake.confirm(review),
      (error: any) => error?.code === 'TASK_MODEL_REVIEW_DENIED');
    assert.equal(submits, 0);
  }
  nativeResult = true;
  assert.equal((await intake.confirm(review)).taskId, 'queued-task');
  assert.equal(submits, 1);
});

test('C05 Stop while refreshing post-model approved scope cannot mint a review receipt', async () => {
  let releaseRefresh!: () => void;
  const refresh = new Promise<void>(resolve => { releaseRefresh = resolve; });
  let secondRead!: () => void;
  const secondReadStarted = new Promise<void>(resolve => { secondRead = resolve; });
  let reads = 0, submitted = 0;
  const model = new BoundedModelGoalInference({
    modelId: 'injected-model', maxOutputTokens: 256, maxCostMicros: 0, timeoutMs: 1000,
    ledger: { async reserve() { return { reservationId: 'reserved' }; }, async finalize() {} },
    generator: { async generate() { return { text: JSON.stringify(modelResponse) }; } }
  });
  const intake = new TrustedReviewedModelTaskIntake({
    model, authority: {
      async currentApprovedScope() {
        reads++;
        if (reads === 2) { secondRead(); await refresh; }
        return scope;
      },
      async verifyTrustedReview() { return true; },
      async submitReviewedTask() {
        submitted++;
        return { id: 'should-not-submit', executionStarted: false as const };
      }
    }
  });
  const stop = new AbortController();
  const pending = intake.propose({
    principal: 'trusted-local-owner', request: scope, allowModelTransmission: true,
    signal: stop.signal
  });
  await secondReadStarted;
  stop.abort('EMERGENCY_STOPPED');
  releaseRefresh();
  await assert.rejects(pending, (error: any) => error?.code === 'TASK_MODEL_INFERENCE_ABORTED');
  assert.equal(submitted, 0);
});

test('C05 caller mutation during model inference cannot rebind trusted review scope', async () => {
  const caller = {
    objective: scope.objective,
    approvedBrowserOrigins: [...scope.approvedBrowserOrigins],
    approvedRoots: [...scope.approvedRoots]
  };
  let beginModel!: () => void, finishModel!: () => void;
  const started = new Promise<void>(resolve => { beginModel = resolve; });
  const release = new Promise<void>(resolve => { finishModel = resolve; });
  let transmitted = '';
  const model = new BoundedModelGoalInference({
    modelId: 'injected-model', maxOutputTokens: 256, maxCostMicros: 0, timeoutMs: 1500,
    ledger: {
      async reserve() { return { reservationId: 'synthetic-budget-reservation' }; },
      async finalize() {}
    },
    generator: { async generate(input) {
      transmitted = input.prompt;
      beginModel();
      await release;
      return { text: JSON.stringify(modelResponse) };
    } }
  });
  const intake = new TrustedReviewedModelTaskIntake({
    model, authority: {
      async currentApprovedScope() { return scope; },
      async verifyTrustedReview() { return true; },
      async submitReviewedTask(options) {
        assert.equal(options.objective, scope.objective);
        assert.deepEqual(options.authorizedScope, ['browser:https://allowed.example']);
        return { id: 'durable-queued-task', executionStarted: false as const };
      }
    }
  });
  const request = intake.propose({
    principal: 'authenticated-owner', request: caller, allowModelTransmission: true
  });
  await started;
  caller.approvedBrowserOrigins.push('https://unapproved.example');
  caller.objective = 'A new objective not approved for model transfer';
  finishModel();
  const draft = await request;
  assert.equal(transmitted.includes('unapproved.example'), false);
  assert.equal(transmitted.includes('A new objective'), false);
  const submitted = await intake.confirm({
    principal: 'authenticated-owner', proposalId: draft.proposalId,
    proposalDigest: draft.proposalDigest, reviewProof: 'independent-owner-review'
  });
  assert.equal(submitted.taskId, 'durable-queued-task');
});

test('C05 malformed task intake scope cannot invoke a getter or reserve model spend', async () => {
  let getters = 0, reservations = 0, calls = 0;
  const model = new BoundedModelGoalInference({
    modelId: 'injected-model', maxOutputTokens: 256, maxCostMicros: 0, timeoutMs: 1500,
    ledger: {
      async reserve() { reservations++; return { reservationId: 'unexpected' }; },
      async finalize() {}
    },
    generator: { async generate() { calls++; return { text: JSON.stringify(modelResponse) }; } }
  });
  const intake = new TrustedReviewedModelTaskIntake({
    model, authority: {
      async currentApprovedScope() { return scope; },
      async verifyTrustedReview() { return true; },
      async submitReviewedTask() { throw Error('no submit on malformed scope'); }
    }
  });
  const getter = Object.defineProperty({
    objective: scope.objective, approvedRoots: []
  }, 'approvedBrowserOrigins', {
    enumerable: true, get() { getters++; throw Error('not allowed'); }
  });
  const sparse: string[] = new Array(2);
  sparse[1] = scope.approvedBrowserOrigins[0]!;
  const symbolArray = [...scope.approvedBrowserOrigins] as string[] & Record<symbol, unknown>;
  symbolArray[Symbol('hidden')] = 'write';
  for (const request of [
    getter,
    { ...scope, approvedBrowserOrigins: sparse },
    { ...scope, approvedBrowserOrigins: symbolArray },
    { ...scope, ignoredPermission: true }
  ]) {
    await assert.rejects(intake.propose({
      principal: 'authenticated-owner', request: request as typeof scope, allowModelTransmission: true
    }), (error: any) => error?.code === 'TASK_MODEL_INTAKE_SCOPE_DENIED');
  }
  assert.equal(getters, 0);
  assert.equal(reservations, 0);
  assert.equal(calls, 0);
});
