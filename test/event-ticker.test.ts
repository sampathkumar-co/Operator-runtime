import assert from 'node:assert/strict';
import test from 'node:test';
import { DurableEventTicker } from '../src/core/event-ticker.ts';

test('stage13 ticker coalesces overlapping ticks into one durable tick', async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const events = {
    async tick() {
      calls += 1;
      await gate;
      return { woke: ['wait-a'], timedOut: [] };
    }
  };
  const ticker = new DurableEventTicker(events as any, { intervalMs: 1000 });
  const first = ticker.runOnce();
  const second = ticker.runOnce();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, b);
  assert.equal(calls, 1);
});

test('stage13 ticker validates bounded polling interval', () => {
  const events = { async tick() { return { woke: [], timedOut: [] }; } };
  assert.throws(
    () => new DurableEventTicker(events as any, { intervalMs: 100 }),
    (error: any) => error?.code === 'EVENT_TICKER_INPUT_INVALID'
  );
  assert.throws(
    () => new DurableEventTicker(events as any, { intervalMs: 60_001 }),
    (error: any) => error?.code === 'EVENT_TICKER_INPUT_INVALID'
  );
});
