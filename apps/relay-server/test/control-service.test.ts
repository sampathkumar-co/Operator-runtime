import assert from 'node:assert/strict';
import test from 'node:test';
import { RelayControlService } from '../src/control-service.ts';

const TOKEN = 'relay-control-token-0123456789abcdef';
const DEVICE_ID = '33333333-3333-4333-8333-333333333333';
const ACCOUNT_A = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_B = '22222222-2222-4222-8222-222222222222';

function action() {
  return {
    id: 'oauth-route-test',
    capability: 'computer.inspect',
    risk: 'read',
    input: {},
    provenance: { kind: 'chatgpt' }
  };
}

async function post(port: number, body: unknown) {
  return await fetch(`http://127.0.0.1:${port}/v1/execute`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body)
  });
}
test('verified principals resolve to isolated Operator accounts', async (t) => {
  const dispatchedAccounts: string[] = [];
  const accounts = {
    async resolveOrCreateAccount(principal: { issuer: string; subject: string }) {
      const accountId = principal.subject === 'user-a' ? ACCOUNT_A : ACCOUNT_B;
      return { accountId, principalHash: 'x'.repeat(43), status: 'active', createdAt: new Date(0).toISOString() } as const;
    }
  };
  const hub = {
    async recoverIdempotent() { return null; },
    async dispatch(input: { accountId: string }) {
      dispatchedAccounts.push(input.accountId);
      return { route: { deviceId: DEVICE_ID }, delivery: { id: `delivery-${dispatchedAccounts.length}`, seq: dispatchedAccounts.length } };
    }
  };
  const results = {
    async get(_deviceId: string, seq: number, _deliveryId: string) {
      return {
        deliveryId: `delivery-${seq}`,
        result: { ok: true, capability: 'computer.inspect', provider: 'test', evidence: [], durationMs: 1 }
      };
    }
  };
  const service = new RelayControlService({ hub: hub as any, results: results as any, accounts: accounts as any, token: TOKEN });
  const { port } = await service.listen('127.0.0.1', 0);
  t.after(() => service.close());
  for (const subject of ['user-a', 'user-b']) {
    const response = await post(port, {
      principal: { issuer: 'https://issuer.operator-runtime.dev', subject },
      action: action(),
      waitMs: 1000
    });
    assert.equal(response.status, 200, await response.text());
  }
  assert.deepEqual(dispatchedAccounts, [ACCOUNT_A, ACCOUNT_B]);
});

test('relay control rejects ambiguous account authority', async (t) => {
  const service = new RelayControlService({
    hub: { dispatch: async () => { throw new Error('must not dispatch'); } } as any,
    results: { get: async () => null } as any,
    accounts: { resolveOrCreateAccount: async () => { throw new Error('must not resolve'); } } as any,
    token: TOKEN
  });
  const { port } = await service.listen('127.0.0.1', 0);
  t.after(() => service.close());
  const response = await post(port, {
    accountId: ACCOUNT_A,
    principal: { issuer: 'https://issuer.operator-runtime.dev', subject: 'user-a' },
    action: action(),
    waitMs: 1000
  });
  assert.equal(response.status, 409);
  const body = await response.json() as any;
  assert.equal(body.error.code, 'RELAY_CONTROL_INPUT_INVALID');
});

test('relay control exposes authenticated principal erasure without creating an account', async (t) => {
  const erased: Array<{ issuer: string; subject: string }> = [];
  const service = new RelayControlService({
    hub: { dispatch: async () => { throw new Error('must not dispatch'); } } as any,
    results: { get: async () => null } as any,
    accounts: {
      resolveOrCreateAccount: async () => { throw new Error('must not create'); },
      erasePrincipal: async (principal: { issuer: string; subject: string }) => {
        erased.push(principal);
        return { erased: true, accountId: ACCOUNT_A, releasedDeviceIds: [DEVICE_ID] };
      }
    } as any,
    token: TOKEN
  });
  const { port } = await service.listen('127.0.0.1', 0);
  t.after(() => service.close());
  const response = await fetch(`http://127.0.0.1:${port}/v1/account/erase`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ principal: { issuer: 'https://issuer.operator-runtime.dev', subject: 'user-a' } })
  });
  assert.equal(response.status, 200, await response.text());
  assert.deepEqual(erased, [{ issuer: 'https://issuer.operator-runtime.dev', subject: 'user-a' }]);
});
test('public relay control preserves trusted public-boundary marker in delivery envelope', async (t) => {
  let payload: any;
  const service = new RelayControlService({
    hub: { recoverIdempotent: async () => null, dispatch: async (input: any) => {
      payload = input.payload;
      return { route: { deviceId: DEVICE_ID }, delivery: { id: 'delivery-public', seq: 7 } };
    } } as any,
    results: { get: async () => ({
      deliveryId: 'delivery-public',
      result: { ok: true, capability: 'computer.inspect', provider: 'test', evidence: [], durationMs: 1 }
    }) } as any,
    accounts: { resolveOrCreateAccount: async () => ({ accountId: ACCOUNT_A }) } as any,
    token: TOKEN
  });
  const { port } = await service.listen('127.0.0.1', 0);
  t.after(() => service.close());
  const response = await post(port, {
    principal: { issuer: 'https://issuer.operator-runtime.dev', subject: 'user-a' },
    publicBoundary: true,
    action: action(), waitMs: 1000
  });
  assert.equal(response.status, 200, await response.text());
  assert.equal(payload.publicBoundary, true);
  assert.equal(payload.action.capability, 'computer.inspect');
});

test('completed idempotent result is recovered before routing even when the device is offline', async (t) => {
  const deliveryId = '44444444-4444-4444-8444-444444444444';
  let recoverCalls = 0;
  let dispatchCalls = 0;
  const hub = {
    recoverIdempotent: async () => {
      recoverCalls += 1;
      return { deviceId: DEVICE_ID, delivery: { id: deliveryId, seq: 9 } };
    },
    dispatch: async () => { dispatchCalls += 1; throw new Error('offline route must not be consulted'); }
  };
  const results = {
    get: async (deviceId: string, seq: number) => {
      assert.equal(deviceId, DEVICE_ID);
      assert.equal(seq, 9);
      return { deliveryId, result: { ok: true, capability: 'computer.inspect', provider: 'replay', evidence: [], durationMs: 1 } };
    }
  };
  const service = new RelayControlService({ hub: hub as any, results: results as any, accounts: {} as any, token: TOKEN });
  const { port } = await service.listen('127.0.0.1', 0);
  t.after(() => service.close());
  const response = await post(port, {
    accountId: ACCOUNT_A,
    action: { ...action(), taskId: 'mcp-request-retry' },
    waitMs: 1000
  });
  assert.equal(response.status, 200);
  const body = await response.json() as any;
  assert.equal(body.provider, 'replay');
  assert.equal(recoverCalls, 1);
  assert.equal(dispatchCalls, 0);
});
