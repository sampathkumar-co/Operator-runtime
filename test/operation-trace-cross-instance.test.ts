import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OperationTraceStore } from '../src/core/operation-trace.ts';

test('separate operation-trace instances append complete bounded records without lost or interleaved events', async (t) => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-trace-multi-'));
  t.after(() => fs.rm(state, {recursive:true,force:true}));
  const stores = Array.from({length:8}, () => new OperationTraceStore(state));
  const eventCount = 20;
  const traceId = 'cross-instance-trace';
  const results = await Promise.all(Array.from({length:eventCount}, (_,i) =>
    stores[i % stores.length]!.append({
      traceId, stage:'REQUEST', outcome:'OK', at: new Date().toISOString(),
      executionContextDigest: 'a'.repeat(64),
      attributes: { eventIndex:i, ...Object.fromEntries(Array.from({length:18},(_,j)=>['pad'+j,'x'.repeat(900)])) }
    })
  ));
  assert.equal(results.length,eventCount);
  assert.equal(new Set(results.map((result)=>result.id)).size,eventCount);
  const read = await new OperationTraceStore(state).list({traceId,limit:100});
  assert.equal(read.length,eventCount);
  assert.deepEqual(new Set(read.map((event)=>event.id)),new Set(results.map((event)=>event.id)));
  assert.deepEqual(new Set(read.map((event)=>event.attributes.eventIndex)),new Set(Array.from({length:eventCount},(_,i)=>i)));
  const raw = await fs.readFile(path.join(state,'operation-traces.ndjson'),'utf8');
  assert.equal(raw.endsWith('\n'),true);
  const lines=raw.split('\n').filter(Boolean);
  assert.equal(lines.length,eventCount);
  for(const line of lines) assert.equal(JSON.parse(line).schemaVersion,1);
});
