import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { DurableEventRuntime } from '../src/core/event-runtime.ts';

const eventModule = fileURLToPath(new URL('../src/core/event-runtime.ts', import.meta.url));
const workerCode = `
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
const [stateDir, prefix, modulePath] = process.argv.slice(1);
const { DurableEventRuntime } = await import(pathToFileURL(modulePath).href);
const store = new DurableEventRuntime(stateDir);
for (let i=0; i<6; i++) {
  const key = prefix + ':' + i;
  const wait = await store.wait({eventType:'audit.event', correlationKey:key});
  const event = await store.publish({
    id:crypto.randomUUID(), type:'audit.event', correlationKey:key,
    payloadDigest:'f'.repeat(64), occurredAt:new Date().toISOString()
  });
  if (!event.satisfiedWaitIds.includes(wait.id)) throw new Error('lost matching event:' + key);
}
`;

async function runWorker(state: string, prefix: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath,
      ['--experimental-strip-types', '--input-type=module', '-e', workerCode, state, prefix, eventModule],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4096); });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error('event writer process failed (' + code + '/' + signal + '): ' + stderr));
    });
  });
}

test('independent OS processes cannot lose event/wait commits to the same durable event store', async t => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-event-cross-process-audit-'));
  t.after(() => fs.rm(state, { recursive: true, force: true }));
  await Promise.all(['A','B','C'].map(prefix => runWorker(state, prefix)));
  const raw = JSON.parse(await fs.readFile(path.join(state, 'events.json'), 'utf8'));
  assert.equal(raw.waits.length, 18);
  assert.equal(raw.events.length, 18);
  assert.equal(new Set(raw.waits.map((w: any) => w.id)).size, 18);
  assert.equal(new Set(raw.events.map((e: any) => e.id)).size, 18);
  const reopened = new DurableEventRuntime(state);
  for (const wait of raw.waits) {
    const state = await reopened.inspect(wait.id);
    assert.equal(state.state, 'SATISFIED');
    assert.equal(state.satisfiedBy, wait.satisfiedBy);
  }
});
