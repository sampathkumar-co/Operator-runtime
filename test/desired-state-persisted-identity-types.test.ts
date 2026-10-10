import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DesiredStateController } from '../src/core/desired-state.ts';
import { worldValueDigest } from '../src/core/world-model.ts';

const world = { resolveFact: async () => ({ status: 'resolved' as const, value: 'not-healthy', claims: [] }) };
const operations = { inspect: async () => undefined, refresh: async () => undefined, submit: async () => { throw new Error('unexpected side effect'); } };
function request() {
  return { name: 'Preserve critical service', scopeKey: 'service:api',
    desired: [{ entityKey: 'service:api', factKey: 'health', expectedValueDigest: worldValueDigest('healthy') }],
    remediation: { objective: 'Make API healthy', successConditions: ['API responds correctly'],
      authority: { maxRisk: 'write' as const, capabilities: ['file.read'], resources: ['repo:/api'] } }
  };
}

for (const field of ['id', 'contractDigest', 'consecutiveFailures', 'createdAt', 'updatedAt'] as const) {
  test('desired-state persisted record rejects coerced ' + field, async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-desired-typed-'));
    t.after(() => fs.rm(dir, {recursive:true,force:true}));
    const controller = new DesiredStateController(dir, {world:world as any, operations:operations as any});
    const contract = await controller.create(request());
    assert.ok(contract.id);
    const file = path.join(dir, 'desired-state.json');
    const original = JSON.parse(await fs.readFile(file,'utf8'));
    const record = original.contracts[0];
    record[field] = field === 'consecutiveFailures' ? '0' : [record[field]];
    const malformed = JSON.stringify(original);
    await fs.writeFile(file, malformed);
    await assert.rejects(new DesiredStateController(dir, {world:world as any, operations:operations as any}).list(),
      (err:any) => ['DESIRED_STATE_INPUT_INVALID','DESIRED_STATE_CORRUPT'].includes(err?.code));
    assert.equal(await fs.readFile(file,'utf8'),malformed,'recovery must not silently rewrite invalid records');
  });
}
