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
    async get(_deviceId: string, seq: number) {
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
