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
    hub: { dispatch: async (input: any) => {
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

test('receipt acknowledgement verifies action authority before consuming and is retry-safe', async (t) => {
  const deliveryId = '44444444-4444-4444-8444-444444444444';
  let allowReceipt = false;
  let verifyCalls = 0;
  let consumeCalls = 0;
  let releaseCalls = 0;
  const hub = {
    dispatch: async () => { throw new Error('must not dispatch'); },
    verifyIdempotency: async () => {
      verifyCalls += 1;
      if (!allowReceipt) throw Object.assign(new Error('mismatch'), { code: 'RELAY_IDEMPOTENCY_MISMATCH' });
      return { released: releaseCalls > 0 };
    },
    releaseIdempotency: async () => { releaseCalls += 1; return releaseCalls === 1; }
  };
  const results = {
    get: async () => null,
    consume: async () => {
      consumeCalls += 1;
      return consumeCalls === 1 ? { deliveryId, result: { ok: true } } : null;
    }
  };
  const service = new RelayControlService({ hub: hub as any, results: results as any, accounts: {} as any, token: TOKEN });
  const { port } = await service.listen('127.0.0.1', 0);
  t.after(() => service.close());  const ack = async () => await fetch(`http://127.0.0.1:${port}/v1/execute/ack`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      accountId: ACCOUNT_A,
      action: action(),
      deviceId: DEVICE_ID,
      seq: 9,
      deliveryId
    })
  });

  const forged = await ack();
  assert.equal(forged.status, 409);
  assert.equal(consumeCalls, 0);
  assert.equal(releaseCalls, 0);

  allowReceipt = true;
  const accepted = await ack();
  assert.equal(accepted.status, 200, await accepted.text());
  assert.equal(consumeCalls, 1);
  assert.equal(releaseCalls, 1);

  const duplicate = await ack();
  assert.equal(duplicate.status, 200, await duplicate.text());
  assert.equal(verifyCalls, 3);
  assert.equal(consumeCalls, 2);
  assert.equal(releaseCalls, 2);
});
