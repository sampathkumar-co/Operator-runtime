import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TeachModeStore } from '../src/core/studio-teach.ts';

async function temp(t: test.TestContext): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-teach-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function okResult(capability: string) {
  return {
    ok: true,
    capability,
    provider: 'semantic-provider',
    evidence: [{ kind: 'demo', status: 'pass' as const, message: 'demonstrated', timestamp: new Date().toISOString() }],
    durationMs: 1
  };
}

test('stage19 compiles only a stopped verified demonstration into a deterministic semantic workflow', async (t) => {
  const store = new TeachModeStore(await temp(t));
  const session = await store.start({ title: 'Invoice flow', objective: 'Open invoice and export it', scopeKey: 'project:billing' });
  const afterFirst = await store.record(session.id, {
    action: {
      id: 'a1', capability: 'browser.navigate', risk: 'write',
      input: { url: 'https://example.invalid/invoices/42' },
      provenance: { kind: 'user' }
    },
    result: okResult('browser.navigate'),
    resourceKeys: ['browser:billing']
  });
  const sourceStepId = afterFirst.steps[0]!.id;
  await store.record(session.id, {
    action: {
      id: 'a2', capability: 'browser.interact', risk: 'external',
      input: { operation: 'click', selector: { name: 'Export' } },
      provenance: { kind: 'user' }
    },
    result: okResult('browser.interact'),
    resourceKeys: ['browser:billing']
  });
  await store.stop(session.id);
  const verificationReceipt = await store.verify(session.id, [{
    name: 'demonstration-outcome',
    ok: true,
    detail: 'The demonstrated workflow outcome was independently verified.',
    evidenceDigests: [afterFirst.steps[0]!.evidenceDigest]
  }]);
  const workflow = await store.compile(session.id, {
    verificationReceipt,
    parameters: [{ name: 'invoiceUrl', stepId: sourceStepId, jsonPointer: '/url', required: true }]
  });
  assert.equal(workflow.steps.length, 2);
  assert.deepEqual(workflow.steps[1]!.dependsOn, ['step-001']);
  assert.match(workflow.digest, /^[0-9a-f]{64}$/);

  const instantiated = await store.instantiate(workflow.id, { invoiceUrl: 'https://example.invalid/invoices/99' });
  assert.equal(instantiated[0]!.inputTemplate.url, 'https://example.invalid/invoices/99');
  assert.equal(workflow.steps[0]!.inputTemplate.url, 'https://example.invalid/invoices/42');
});

test('stage19 refuses failed actions and secret-bearing demonstrated inputs', async (t) => {
  const store = new TeachModeStore(await temp(t));
  const session = await store.start({ title: 'Safe demo', objective: 'Demonstrate safely', scopeKey: 'project:safe' });
  await assert.rejects(() => store.record(session.id, {
    action: { id: 'fail', capability: 'file.read', risk: 'read', input: { path: '/tmp/a' }, provenance: { kind: 'user' } },
    result: { ...okResult('file.read'), ok: false, error: { code: 'NOPE', message: 'failed' } }
  }), (error: any) => error?.code === 'TEACH_ACTION_UNSUCCESSFUL');

  await assert.rejects(() => store.record(session.id, {
    action: {
      id: 'secret', capability: 'browser.interact', risk: 'external',
      input: { operation: 'type', password: 'should-not-be-stored' },
      provenance: { kind: 'user' }
    },
    result: okResult('browser.interact')
  }), (error: any) => error?.code === 'TEACH_SECRET_REJECTED');
});

test('stage19 requires independent verification digest and explicit parameter paths', async (t) => {
  const store = new TeachModeStore(await temp(t));
  const session = await store.start({ title: 'Param demo', objective: 'Use one parameter', scopeKey: 'project:param' });
  const recorded = await store.record(session.id, {
    action: {
      id: 'a', capability: 'file.read', risk: 'read',
      input: { path: '/workspace/a.txt' }, provenance: { kind: 'user' }
    },
    result: okResult('file.read')
  });
  await store.stop(session.id);

  const failedReceipt = await store.verify(session.id, [{
    name: 'outcome',
    ok: false,
    detail: 'The demonstrated postcondition did not hold.'
  }]);
  await assert.rejects(() => store.compile(session.id, {
    verificationReceipt: failedReceipt,
    parameters: []
  }), (error: any) => error?.code === 'TEACH_VERIFICATION_REQUIRED');

  const validReceipt = await store.verify(session.id, [{
    name: 'outcome',
    ok: true,
    detail: 'The demonstrated postcondition holds.',
    evidenceDigests: [recorded.steps[0]!.evidenceDigest]
  }]);
  const tamperedReceipt = structuredClone(validReceipt);
  tamperedReceipt.digest = 'a'.repeat(64);
  await assert.rejects(() => store.compile(session.id, {
    verificationReceipt: tamperedReceipt,
    parameters: []
  }), (error: any) => error?.code === 'TEACH_VERIFICATION_INVALID');

  await assert.rejects(() => store.compile(session.id, {
    verificationReceipt: validReceipt,
    parameters: [{ name: 'missing', stepId: recorded.steps[0]!.id, jsonPointer: '/does-not-exist', required: true }]
  }), (error: any) => error?.code === 'TEACH_PARAMETER_INVALID');
});
