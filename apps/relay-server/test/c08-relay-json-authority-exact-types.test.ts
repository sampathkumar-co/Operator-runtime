import assert from 'node:assert/strict';
import test from 'node:test';
import { RelayControlService } from '../src/control-service.ts';

const TOKEN = 'relay-control-token-0123456789abcdef';
const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const DEVICE = '33333333-3333-4333-8333-333333333333';
const validAction = { id: 'trusted-action', capability: 'computer.inspect',
  risk: 'read', input: {}, provenance: { kind: 'chatgpt' } };

test('C08 malformed JSON identity, account, route, risk and wait types never reach relay dispatch', async t => {
  let dispatched = 0;
  let selected = 0;
  let removed = 0;
  const service = new RelayControlService({
    hub: {
      dispatch: async () => { dispatched++; throw new Error('INVALID_DISPATCH'); },
      recoverIdempotent: async () => { dispatched++; throw new Error('INVALID_RECOVERY'); },
      setDefaultDevice: async () => { selected++; throw new Error('INVALID_DEFAULT_DEVICE'); }
    } as any,
    results: {
      findByIdempotencyKey: async () => { dispatched++; throw new Error('INVALID_RESULT_LOOKUP'); }
    } as any,
    accounts: {
      resolveOrCreateAccount: async () => ({ accountId: ACCOUNT }),
      removeDevice: async () => { removed++; throw new Error('INVALID_REMOVE_DEVICE'); }
    } as any, token: TOKEN
  });
  const { port } = await service.listen('127.0.0.1', 0);
  t.after(() => service.close());
  async function post(route, body) {
    const response = await fetch('http://127.0.0.1:' + port + route, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    const output = await response.json();
    assert.equal(response.status, 409, JSON.stringify({ route, body, output }));
    assert.equal(output.error?.code, 'RELAY_CONTROL_INPUT_INVALID');
  }
  const ordinary = { accountId: ACCOUNT, action: validAction, waitMs: 1000 };
  const invalid = [
    { ...ordinary, accountId: [ACCOUNT] },
    { ...ordinary, deviceId: [DEVICE] },
    { ...ordinary, projectKey: ['project-name'] },
    { ...ordinary, waitMs: '1000' },
    { ...ordinary, action: { ...validAction, id: ['trusted-action'] } },
    { ...ordinary, action: { ...validAction, capability: ['computer.inspect'] } },
    { ...ordinary, action: { ...validAction, risk: ['read'] } },
    { ...ordinary, action: { ...validAction, target: ['/authorized'] } },
    { principal: { issuer: ['https://issuer.test'], subject: 'user-1' },
      action: validAction, waitMs: 1000 },
    { principal: { issuer: 'https://issuer.test', subject: ['user-1'] },
      action: validAction, waitMs: 1000 }
  ];
  for (const input of invalid) await post('/v1/execute', input);
  await post('/v1/account/default-device', { accountId: ACCOUNT, deviceId: [DEVICE] });
  await post('/v1/account/devices/remove', {
    principal: { issuer: 'https://issuer.test', subject: 'user-1' }, deviceId: [DEVICE]
  });
  assert.equal(dispatched, 0);
  assert.equal(selected, 0);
  assert.equal(removed, 0);
});
