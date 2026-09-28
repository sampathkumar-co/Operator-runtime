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
