import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalRuntimeLifecycle } from '../apps/local-agent/src/runtime-lifecycle.ts';

test('R1 local lifecycle shutdown is idempotent and drains relay before releasing state', async () => {
  const events: string[] = [];
  let resolveRelay!: () => void;
  const relay = new Promise<void>((resolve) => { resolveRelay = resolve; });
  const lifecycle = new LocalRuntimeLifecycle({
    stopRelay: () => { events.push('stop-relay'); resolveRelay(); },
    pendingRelay: () => relay.then(() => { events.push('relay-drained'); }),
    stopServices: () => [
      Promise.resolve().then(() => { events.push('service-a'); }),
      Promise.resolve().then(() => { events.push('service-b'); })
    ],
    releaseStateLock: async () => { events.push('release-state'); },
    setExitCode: (code) => { events.push('exit-' + code); }
  });

  assert.equal(lifecycle.shuttingDown, false);
  await Promise.all([
    lifecycle.shutdown(0, 'test'),
    lifecycle.shutdown(0, 'test')
  ]);
  assert.equal(lifecycle.shuttingDown, true);
  assert.equal(events.filter((item) => item === 'stop-relay').length, 1);
  assert.ok(events.indexOf('relay-drained') < events.indexOf('release-state'));
  assert.ok(events.indexOf('service-a') < events.indexOf('release-state'));
  assert.ok(events.indexOf('service-b') < events.indexOf('release-state'));
  assert.equal(events.at(-1), 'exit-0');
});

test('R1 fatal relay shutdown can skip self-wait but still drains services and releases state', async () => {
  let relayObserved = false;
  let released = false;
  const lifecycle = new LocalRuntimeLifecycle({
    stopRelay: () => undefined,
    pendingRelay: () => {
      relayObserved = true;
      return Promise.resolve();
    },
    stopServices: () => [Promise.resolve()],
    releaseStateLock: async () => { released = true; },
    setExitCode: () => undefined
  });

  await lifecycle.shutdown(1, 'relay-failure', { awaitRelay: false });
  assert.equal(relayObserved, false);
  assert.equal(released, true);
});
