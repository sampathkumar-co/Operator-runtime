import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resourceKeysForAction, resolvePhysicalResourceKeysForAction
} from '../src/core/resource-identity.ts';
import type { ActionRequest } from '../src/core/types.ts';

const request = (capability: string, input: Record<string, unknown>): ActionRequest => ({
  id: 'c02-literal-resource-identity', capability, risk: 'read',
  input, provenance: { kind: 'runtime' }
});

test('C02 terminal declared ports require literal numeric resource identity before dispatch', () => {
  const keys = resourceKeysForAction(request('terminal.session', {
    operation: 'start', cwd: '/authorized', ports: [8080, 5432]
  }));
  assert.ok(keys.includes('network:tcp:8080'));
  assert.ok(keys.includes('network:tcp:5432'));

  let invocations = 0;
  const adversarial = { toString() { invocations++; return '8080'; },
    valueOf() { invocations++; return 8080; } };
  for (const ports of [
    [adversarial], ['8080'], [true], [[8080]],
    [0], [65536], [Number.NaN], [1.5], Array(1),
    Array.from({ length: 129 }, () => 8080), '8080'
  ]) {
    assert.throws(
      () => resourceKeysForAction(request('terminal.session', {
        operation: 'start', cwd: '/authorized', ports
      })),
      (error: any) => error?.code === 'RESOURCE_TARGET_INVALID',
      'malformed ports cannot silently narrow exclusive network resource keys'
    );
  }
  assert.equal(invocations, 0, 'resource extraction never executes attacker coercion');
});

test('C02 process resource identity never invokes coerced PID or invents process ownership', async () => {
  let invocations = 0;
  const spoof = { valueOf() { invocations++; return 4242; },
    toString() { invocations++; return '4242'; } };
  const wrong = request('process.manage', { pid: spoof });
  const keys = resourceKeysForAction(wrong);
  assert.ok(keys.includes('process:windows'), 'unknown PID conservatively locks process scope');
  assert.equal(keys.includes('process:windows/4242'), false);
  const physical = await resolvePhysicalResourceKeysForAction(wrong);
  assert.ok(physical.includes('process:windows'));
  assert.equal(invocations, 0, 'hostile PID conversion never executed');

  const valid = await resolvePhysicalResourceKeysForAction(request('process.manage', { pid: 4242 }));
  assert.ok(valid.includes('process:windows/4242'));
  assert.equal(valid.includes('process:windows'), false);
});
