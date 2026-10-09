import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DesiredStateController } from '../src/core/desired-state.ts';
import { worldValueDigest } from '../src/core/world-model.ts';

async function temp(t: test.TestContext): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-desired-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

class FakeWorld {
  value: unknown = 'broken';
  async resolveFact() {
    return { status: 'resolved' as const, value: this.value, claims: [] };
  }
}

class FakeOperations {
  submitted: any[] = [];
  operations = new Map<string, any>();
  async submit(input: any) {
    this.submitted.push(structuredClone(input));
    const id = input.requestId ?? crypto.randomUUID();
    const existing = this.operations.get(id);
    if (existing) return structuredClone(existing);
    const operation = {
      version: 1,
      id,
      objective: input.objective,
      scopeKey: input.scopeKey,
      successConditions: input.successConditions,
      state: 'RUNNING',
      mode: 'team',
      preconditions: input.preconditions ?? [],
      postconditions: input.postconditions ?? [],
      selectedStrategy: 'fresh-plan',
      submissionDigest: 'a'.repeat(64),
      outcomeRecorded: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    this.operations.set(id, operation);
    return structuredClone(operation);
  }
  async refresh(id: string) {
    return structuredClone(this.operations.get(id));
  }
  async cancel(id: string) {
    const operation = this.operations.get(id);
    operation.state = 'CANCELLED';
    return structuredClone(operation);
  }
}

function createInput(overrides: any = {}) {
  return {
    name: 'Keep API healthy',
    scopeKey: 'project:api',
    desired: [{
      entityKey: 'service:api',
      factKey: 'health',
      expectedValueDigest: worldValueDigest('healthy')
    }],
    remediation: {
      objective: 'Restore API health',
      successConditions: ['service is healthy'],
      authority: {
        maxRisk: 'write' as const,
        capabilities: ['project.inspect', 'file.write'],
        resources: ['repo:/workspace/api']
      }
    },
    ...overrides
  };
}

test('stage20 detects drift without acting when auto remediation is disabled', async (t) => {
  const world = new FakeWorld();
  const operations = new FakeOperations();
  const controller = new DesiredStateController(await temp(t), { world: world as any, operations: operations as any });
  const contract = await controller.create(createInput());
  assert.equal(contract.status, 'DRIFTED');

  const checked = await controller.reconcile(contract.id);
  assert.equal(checked.status, 'DRIFTED');
  assert.equal(operations.submitted.length, 0);
});

test('stage20 starts remediation only through bounded Digital Operations authority and postconditions', async (t) => {
  const world = new FakeWorld();
  const operations = new FakeOperations();
  const controller = new DesiredStateController(await temp(t), { world: world as any, operations: operations as any });
  const contract = await controller.create(createInput({
    policy: { autoRemediate: true, minRemediationIntervalMs: 0, maxConsecutiveFailures: 3, maxRemediationsPerDay: 10 }
  }));

  const running = await controller.reconcile(contract.id);
  assert.equal(running.status, 'REMEDIATING');
  assert.equal(operations.submitted.length, 1);
  assert.deepEqual(operations.submitted[0].authority, {
    capabilities: ['project.inspect', 'file.write'],
    resources: ['repo:/workspace/api']
  });
  assert.equal(operations.submitted[0].maxRisk, 'write');
  assert.deepEqual(operations.submitted[0].postconditions, createInput().desired);
  assert.equal(operations.submitted[0].run, true);

  const operation = operations.operations.get(running.activeOperationId!);
  operation.state = 'VERIFIED';
  world.value = 'healthy';
  const healthy = await controller.reconcile(contract.id);
  assert.equal(healthy.status, 'HEALTHY');
  assert.equal(healthy.activeOperationId, undefined);
  assert.equal(healthy.remediationHistory[0]!.outcome, 'verified');
  assert.equal(healthy.consecutiveFailures, 0);
});

test('stage20 bounded failure budget blocks autonomous remediation loops', async (t) => {
  const world = new FakeWorld();
  const operations = new FakeOperations();
  const controller = new DesiredStateController(await temp(t), { world: world as any, operations: operations as any });
  const contract = await controller.create(createInput({
    policy: { autoRemediate: true, minRemediationIntervalMs: 0, maxConsecutiveFailures: 2, maxRemediationsPerDay: 10 }
  }));

  let current = await controller.reconcile(contract.id);
  operations.operations.get(current.activeOperationId!).state = 'FAILED';
  current = await controller.reconcile(contract.id);
  assert.equal(current.status, 'REMEDIATING');
  operations.operations.get(current.activeOperationId!).state = 'FAILED';
  current = await controller.reconcile(contract.id);
  assert.equal(current.status, 'BLOCKED');
  assert.equal(current.consecutiveFailures, 2);
  assert.equal(operations.submitted.length, 2);
});

test('stage20 contract ids are idempotent and conflicting reuse is rejected', async (t) => {
  const world = new FakeWorld();
  const operations = new FakeOperations();
  const controller = new DesiredStateController(await temp(t), { world: world as any, operations: operations as any });
  const contractId = crypto.randomUUID();
  const first = await controller.create(createInput({ contractId }));
  const same = await controller.create(createInput({ contractId }));
  assert.equal(same.id, first.id);
  await assert.rejects(
    () => controller.create(createInput({ contractId, name: 'Different contract' })),
    (error: any) => error?.code === 'DESIRED_STATE_CONFLICT'
  );
});

test('stage20 never dispatches remediation before durable reservation is confirmed', async (t) => {
  const state = await temp(t);
  const world = new FakeWorld();
  const operations = new FakeOperations();
  let failNextPersist = false;
  const controller = new DesiredStateController(state, {
    world: world as any, operations: operations as any,
    beforePersist: () => { if (failNextPersist) { failNextPersist = false; throw new Error('forced desired-state persistence failure'); } }
  });
  const contract = await controller.create(createInput({
    policy: { autoRemediate: true, minRemediationIntervalMs: 0, maxConsecutiveFailures: 3, maxRemediationsPerDay: 10 }
  }));
  failNextPersist = true;
  await assert.rejects(() => controller.reconcile(contract.id), /forced desired-state persistence failure/);
  assert.equal(operations.operations.size, 0);
  assert.equal(operations.submitted.length, 0);

  const restarted = new DesiredStateController(state, { world: world as any, operations: operations as any });
  const recovered = await restarted.reconcile(contract.id);
  assert.equal(recovered.status, 'REMEDIATING');
  assert.equal(operations.operations.size, 1);
  assert.equal(operations.submitted.length, 1);
  assert.equal(recovered.activeOperationId, operations.submitted[0].requestId);
});


test('stage20 persisted contract tampering cannot widen remediation authority', async (t) => {
  const state = await temp(t);
  const world = new FakeWorld();
  const operations = new FakeOperations();
  const controller = new DesiredStateController(state, { world: world as any, operations: operations as any });
  const contract = await controller.create(createInput({
    policy: { autoRemediate: true, minRemediationIntervalMs: 0, maxConsecutiveFailures: 3, maxRemediationsPerDay: 10 }
  }));

  const file = path.join(state, 'desired-state.json');
  const raw = JSON.parse(await fs.readFile(file, 'utf8')) as any;
  raw.contracts[0].remediation.authority.maxRisk = 'destructive';
  raw.contracts[0].remediation.authority.capabilities.push('terminal.execute');
  await fs.writeFile(file, JSON.stringify(raw, null, 2), 'utf8');

  const reloaded = new DesiredStateController(state, { world: world as any, operations: operations as any });
  await assert.rejects(
    () => reloaded.inspect(contract.id),
    (error: any) => error?.code === 'DESIRED_STATE_CORRUPT'
  );
});


test('stage20 reconciliation scheduling rotates oldest active contracts without changing recent-list ordering', async (t) => {
  let nowMs = Date.parse('2026-10-01T00:00:00.000Z');
  const clock = () => new Date(nowMs);
  const world = new FakeWorld();
  const operations = new FakeOperations();
  const controller = new DesiredStateController(await temp(t), {
    world: world as any, operations: operations as any, clock
  });

  const first = await controller.create(createInput({
    contractId: '00000000-0000-4000-8000-000000000001', name: 'first'
  }));
  nowMs += 1_000;
  const second = await controller.create(createInput({
    contractId: '00000000-0000-4000-8000-000000000002', name: 'second'
  }));
  nowMs += 1_000;
  const third = await controller.create(createInput({
    contractId: '00000000-0000-4000-8000-000000000003', name: 'third'
  }));

  assert.deepEqual((await controller.list(3)).map((item) => item.id), [third.id, second.id, first.id]);
  assert.deepEqual((await controller.listForReconciliation(1)).map((item) => item.id), [first.id]);

  nowMs += 1_000;
  await controller.reconcile(first.id);
  assert.deepEqual((await controller.listForReconciliation(1)).map((item) => item.id), [second.id]);

  nowMs += 1_000;
  await controller.pause(second.id);
  assert.deepEqual((await controller.listForReconciliation(2)).map((item) => item.id), [third.id, first.id]);
});

test('independent controllers reserve one operation durably before dispatch and never double-submit', async t => {
  const state=await temp(t), world=new FakeWorld(), operations=new FakeOperations();
  const first=new DesiredStateController(state,{world:world as any,operations:operations as any});
  const second=new DesiredStateController(state,{world:world as any,operations:operations as any});
  const contract=await first.create(createInput({policy:{autoRemediate:true,minRemediationIntervalMs:0}}));
  let entered!:()=>void,finish!:()=>void;
  const started=new Promise<void>(resolve=>entered=resolve);
  const gate=new Promise<void>(resolve=>finish=resolve);
  const original=operations.submit.bind(operations);
  operations.submit=async(input:any)=>{const operation=await original(input);entered();await gate;return operation;};
  const a=first.reconcile(contract.id);
  await started;
  const persisted=JSON.parse(await fs.readFile(path.join(state,'desired-state.json'),'utf8'));
  const reserved=persisted.contracts[0];
  assert.equal(reserved.activeOperationId,operations.submitted[0].requestId);
  assert.equal(reserved.remediationHistory.length,1);
  const b=second.reconcile(contract.id);
  try {
    assert.equal(await Promise.race([b.then(()=>true),new Promise<boolean>(resolve=>setTimeout(()=>resolve(false),80))]),false);
  } finally { finish(); }
  const [one,two]=await Promise.all([a,b]);
  assert.equal(one.activeOperationId,two.activeOperationId);
  assert.equal(operations.submitted.length,1);
});

test('unknown post-reservation dispatch is quarantined without replay after restart',async t=>{
  const state=await temp(t),world=new FakeWorld(),ops=new FakeOperations();
  const controller=new DesiredStateController(state,{world:world as any,operations:ops as any});
  const contract=await controller.create(createInput({policy:{autoRemediate:true,minRemediationIntervalMs:0}}));
  ops.submit=async (input:any)=>{ops.submitted.push(structuredClone(input));throw new Error('synthetic crash after write-ahead');};
  await assert.rejects(controller.reconcile(contract.id),/synthetic crash/);
  const reserved=(JSON.parse(await fs.readFile(path.join(state,'desired-state.json'),'utf8'))).contracts[0];
  assert.equal(reserved.status,'REMEDIATING');
  assert.equal(reserved.activeOperationId,ops.submitted[0].requestId);
  assert.equal(reserved.remediationHistory.length,1);
  const restarted=new DesiredStateController(state,{world:world as any,operations:ops as any});
  const blocked=await restarted.reconcile(contract.id);
  assert.equal(blocked.status,'BLOCKED');
  assert.equal(blocked.activeOperationId,reserved.activeOperationId);
  assert.equal(ops.submitted.length,1);
});

test('pause persists revocation before effectful cancellation',async t=>{
  const state=await temp(t), world=new FakeWorld(),ops=new FakeOperations();
  const controller=new DesiredStateController(state,{world:world as any,operations:ops as any});
  const contract=await controller.create(createInput({policy:{autoRemediate:true,minRemediationIntervalMs:0}}));
  await controller.reconcile(contract.id);
  const previous=ops.cancel.bind(ops);
  ops.cancel=async id=>{
    const saved=JSON.parse(await fs.readFile(path.join(state,'desired-state.json'),'utf8'));
    assert.equal(saved.contracts[0].status,'PAUSED');
    assert.equal(saved.contracts[0].activeOperationId,id);
    return await previous(id);
  };
  const paused=await controller.pause(contract.id,{cancelActive:true});
  assert.equal(paused.status,'PAUSED');
  assert.equal(paused.activeOperationId,undefined);
  assert.equal(paused.remediationHistory[0]?.outcome,'cancelled');
});

test('post-dispatch persistence failure keeps write-ahead operation identity and never replays',async t=>{
 const state=await temp(t),world=new FakeWorld(),ops=new FakeOperations();
 let writes=0;
 const controller=new DesiredStateController(state,{
   world:world as any,operations:ops as any,
   beforePersist:()=>{writes+=1;if(writes===3)throw new Error('synthetic post-dispatch state loss');}
 });
 const contract=await controller.create(createInput({policy:{autoRemediate:true,minRemediationIntervalMs:0}}));
 await assert.rejects(controller.reconcile(contract.id),/synthetic post-dispatch state loss/);
 assert.equal(ops.submitted.length,1);
 const record=JSON.parse(await fs.readFile(path.join(state,'desired-state.json'),'utf8')).contracts[0];
 assert.equal(record.activeOperationId,ops.submitted[0].requestId);
 assert.equal(record.remediationHistory.length,1);
 const restarted=new DesiredStateController(state,{world:world as any,operations:ops as any});
 const resumed=await restarted.reconcile(contract.id);
 assert.equal(resumed.status,'REMEDIATING');
 assert.equal(ops.submitted.length,1);
 assert.equal(resumed.activeOperationId,record.activeOperationId);
});

test('cancellation uncertainty leaves persisted pause and blocks unsafe resume',async t=>{
 const state=await temp(t),world=new FakeWorld(),ops=new FakeOperations();
 const controller=new DesiredStateController(state,{world:world as any,operations:ops as any});
 const contract=await controller.create(createInput({policy:{autoRemediate:true,minRemediationIntervalMs:0}}));
 const active=await controller.reconcile(contract.id);
 ops.cancel=async()=>{throw new Error('synthetic lost cancellation response')};
 await assert.rejects(controller.pause(contract.id,{cancelActive:true}),/synthetic lost cancellation response/);
 const restarted=new DesiredStateController(state,{world:world as any,operations:ops as any});
 const record=await restarted.inspect(contract.id);
 assert.equal(record.status,'PAUSED');
 assert.equal(record.activeOperationId,active.activeOperationId);
 await assert.rejects(restarted.resume(contract.id),(error:any)=>error?.code==='DESIRED_STATE_RECONCILIATION_REQUIRED');
 assert.equal(ops.submitted.length,1);
});

test('reserved remediation id never accepts an operation bound to another scope', async t => {
 const world=new FakeWorld(),operations=new FakeOperations();
 const controller=new DesiredStateController(await temp(t),{world:world as any,operations:operations as any});
 const contract=await controller.create(createInput({policy:{autoRemediate:true,minRemediationIntervalMs:0}}));
 const running=await controller.reconcile(contract.id);
 const unrelated=operations.operations.get(running.activeOperationId!);
 unrelated.scopeKey='project:another-customer';
 const blocked=await controller.reconcile(contract.id);
 assert.equal(blocked.status,'BLOCKED');
 assert.equal(blocked.activeOperationId,running.activeOperationId);
 assert.match(blocked.lastReason||'',/handoff is unresolved/i);
 assert.equal(operations.submitted.length,1);
});

test('reserved remediation id never accepts divergent machine postconditions or success contract', async t => {
 const world=new FakeWorld(),operations=new FakeOperations();
 const controller=new DesiredStateController(await temp(t),{world:world as any,operations:operations as any});
 const contract=await controller.create(createInput({policy:{autoRemediate:true,minRemediationIntervalMs:0}}));
 const running=await controller.reconcile(contract.id);
 const active=operations.operations.get(running.activeOperationId!);
 active.postconditions=[{entityKey:'service:unrelated',factKey:'health',expectedValueDigest:worldValueDigest('healthy')}];
 const blocked=await controller.reconcile(contract.id);
 assert.equal(blocked.status,'BLOCKED');
 assert.equal(blocked.activeOperationId,running.activeOperationId);
 assert.equal(operations.submitted.length,1);
});
