import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DurableEventRuntime } from '../src/core/event-runtime.ts';

test('durable event state cannot claim SATISFIED without a valid terminal event/timer receipt', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-event-terminal-integrity-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new DurableEventRuntime(root);
  const waitId = crypto.randomUUID();
  await store.wait({waitId, eventType:'release.approved', correlationKey:'release:1'});
  const file = path.join(root, 'events.json');
  const original = JSON.parse(await fs.readFile(file, 'utf8'));

  for (const change of [
    (w: any) => {w.state='SATISFIED'; w.terminalAt=w.createdAt;},
    (w: any) => {w.state='SATISFIED'; w.satisfiedBy='not-an-event'; w.satisfiedAt=w.createdAt; w.terminalAt=w.createdAt;},
    (w: any) => {w.state='SATISFIED'; w.satisfiedBy='timer:another-wait'; w.satisfiedAt=w.createdAt; w.terminalAt=w.createdAt;}
  ]) {
    const modified = structuredClone(original);
    change(modified.waits[0]);
    await fs.writeFile(file, JSON.stringify(modified));
    await assert.rejects(
      () => new DurableEventRuntime(root).inspect(waitId),
      (error: any) => error?.code==='EVENT_STATE_CORRUPT',
      'terminal success must have a correctly typed provenance receipt'
    );
  }
  await fs.writeFile(file, JSON.stringify(original));
  const eventId = crypto.randomUUID();
  await store.publish({id:eventId, type:'release.approved', correlationKey:'release:1',
    payloadDigest:'a'.repeat(64), occurredAt:new Date().toISOString()});
  const valid = await new DurableEventRuntime(root).inspect(waitId);
  assert.equal(valid.state,'SATISFIED');
  assert.equal(valid.satisfiedBy,eventId);
  assert.ok(valid.satisfiedAt);
});

test('durable event success cannot be attributed to a retained foreign event', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-event-foreign-receipt-'));
  t.after(() => fs.rm(root, {recursive:true,force:true}));
  const runtime = new DurableEventRuntime(root);
  const wait = await runtime.wait({eventType:'release.approved',correlationKey:'release:ours'});
  const foreign = {id:crypto.randomUUID(),type:'release.approved',correlationKey:'release:other',
    payloadDigest:'b'.repeat(64),occurredAt:new Date().toISOString()};
  const result = await runtime.publish(foreign);
  assert.deepEqual(result.satisfiedWaitIds,[]);
  const file = path.join(root,'events.json');
  const tampered = JSON.parse(await fs.readFile(file,'utf8'));
  tampered.waits[0].state='SATISFIED';
  tampered.waits[0].satisfiedBy=foreign.id;
  tampered.waits[0].satisfiedAt=wait.createdAt;
  tampered.waits[0].terminalAt=wait.createdAt;
  await fs.writeFile(file,JSON.stringify(tampered));
  await assert.rejects(
    () => new DurableEventRuntime(root).inspect(wait.id),
    (error:any) => error?.code==='EVENT_STATE_CORRUPT',
    'an existing event must match the exact wait type and correlation'
  );
});
