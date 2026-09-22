import assert from 'node:assert/strict';
import test from 'node:test';
import { OperatorError } from '../../../src/core/errors.ts';
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

function writeAction() {
  return {
    id: 'write-retry-test',
    capability: 'file.create',
    risk: 'write',
    input: { path: 'safe-retry.txt', content: 'safe retry fixture' },
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
    },
    async activeMembershipForDevice() {
      const accountId = dispatchedAccounts.at(-1)!;
      return { accountId, deviceId: DEVICE_ID, status: 'active', addedAt: new Date(0).toISOString(), authorityGeneration: 1 } as const;
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
    async findByIdempotencyKey() { return null; },
    async get(_deviceId: string, seq: number, _deliveryId: string) {
      return {
        deliveryId: `delivery-${seq}`,
        result: { ok: true, capability: 'computer.inspect', provider: 'test', evidence: [], durationMs: 1 },
        replayAuthority: { accountId: dispatchedAccounts[seq - 1], deviceId: DEVICE_ID, generation: 1 }
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
    results: { findByIdempotencyKey: async () => null, get: async () => ({
      deliveryId: 'delivery-public',
      result: { ok: true, capability: 'computer.inspect', provider: 'test', evidence: [], durationMs: 1 },
      replayAuthority: { accountId: ACCOUNT_A, deviceId: DEVICE_ID, generation: 1 }
    }) } as any,
    accounts: {
      resolveOrCreateAccount: async () => ({ accountId: ACCOUNT_A }),
      activeMembershipForDevice: async () => ({ accountId: ACCOUNT_A, deviceId: DEVICE_ID, authorityGeneration: 1 })
    } as any,
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

test('completed non-read result is recovered before routing even when the device is offline', async (t) => {
  const deliveryId = '44444444-4444-4444-8444-444444444444';
  let recoverCalls = 0;
  let dispatchCalls = 0;
  const hub = {
    recoverIdempotent: async () => { recoverCalls += 1; throw new Error('delivery recovery must not be consulted for completed work'); },
    dispatch: async () => { dispatchCalls += 1; throw new Error('offline route must not be consulted'); }
  };
  const results = {
    findByIdempotencyKey: async () => ({
      deviceId: DEVICE_ID,
      result: { seq: 9, deliveryId, result: { ok: true, capability: 'computer.inspect', provider: 'replay', evidence: [], durationMs: 1 }, replayAuthority: { accountId: ACCOUNT_A, deviceId: DEVICE_ID, generation: 1 } }
    }),
    get: async () => { throw new Error('sequence polling must not be consulted for completed work'); }
  };
  const accounts = { activeMembershipForDevice: async () => ({ accountId: ACCOUNT_A, deviceId: DEVICE_ID, authorityGeneration: 1 }) };
  const service = new RelayControlService({ hub: hub as any, results: results as any, accounts: accounts as any, token: TOKEN });
  const { port } = await service.listen('127.0.0.1', 0);
  t.after(() => service.close());
  const response = await post(port, {
    accountId: ACCOUNT_A,
    action: { ...action(), risk: 'write', taskId: 'mcp-request-retry' },
    waitMs: 1000
  });
  assert.equal(response.status, 200);
  const body = await response.json() as any;
  assert.equal(body.provider, 'replay');
  assert.equal(recoverCalls, 0);
  assert.equal(dispatchCalls, 0);
});


test('completed replay is rejected after account-device authority generation changes', async (t) => {
  let dispatchCalls = 0;
  const results = {
    findByIdempotencyKey: async () => ({
      deviceId: DEVICE_ID,
      result: { seq: 10, deliveryId: '66666666-6666-4666-8666-666666666666', result: { ok: true, capability: 'computer.inspect', provider: 'stale', evidence: [], durationMs: 1 }, replayAuthority: { accountId: ACCOUNT_A, deviceId: DEVICE_ID, generation: 1 } }
    }),
    get: async () => null
  };
  const accounts = { activeMembershipForDevice: async () => ({ accountId: ACCOUNT_A, deviceId: DEVICE_ID, authorityGeneration: 2 }) };
  const hub = { recoverIdempotent: async () => null, dispatch: async () => { dispatchCalls += 1; throw new Error('must not dispatch stale replay'); } };
  const service = new RelayControlService({ hub: hub as any, results: results as any, accounts: accounts as any, token: TOKEN });
  const { port } = await service.listen('127.0.0.1', 0);
  t.after(() => service.close());
  const response = await post(port, { accountId: ACCOUNT_A, action: { ...action(), taskId: 'stale-generation' }, waitMs: 1000 });
  assert.equal(response.status, 409);
  assert.equal((await response.json() as any).error.code, 'RELAY_RESULT_AUTHORITY_REVOKED');
  assert.equal(dispatchCalls, 0);
});


test('expired idempotent invocation fails closed instead of dispatching the side effect again', async (t) => {
  let dispatchCalls = 0;
  const hub = {
    recoverIdempotent: async () => ({ deviceId: DEVICE_ID, delivery: { id: '55555555-5555-4555-8555-555555555555', seq: 11, status: 'expired' } }),
    dispatch: async () => { dispatchCalls += 1; throw new Error('must not redispatch expired invocation'); }
  };
  const results = { findByIdempotencyKey: async () => null, get: async () => null };
  const service = new RelayControlService({ hub: hub as any, results: results as any, accounts: {} as any, token: TOKEN });
  const { port } = await service.listen('127.0.0.1', 0);
  t.after(() => service.close());
  const response = await post(port, { accountId: ACCOUNT_A, action: { ...action(), taskId: 'expired-invocation' }, waitMs: 1000 });
  assert.equal(response.status, 409);
  const body = await response.json() as any;
  assert.equal(body.error.code, 'RELAY_EXECUTION_EXPIRED_UNCERTAIN');
  assert.equal(dispatchCalls, 0);
});

test('device enrollment quota is rejected before permanent registration', async (t) => {
  let registrations = 0;
  const service = new RelayControlService({
    hub: {} as any, results: {} as any,
    accounts: {
      resolveOrCreateAccount: async () => ({ accountId: ACCOUNT_A }),
      assertCanBindDevice: async () => { throw new OperatorError('ACCOUNT_DEVICE_QUOTA', 'quota reached'); }
    } as any,
    enrollments: {
      reserve: async () => ({ enrollmentId: '44444444-4444-4444-8444-444444444444', deviceId: DEVICE_ID }),
      peerForClaim: async () => ({ deviceId: DEVICE_ID, fingerprint: 'x'.repeat(43) }),
      markBound: async () => { throw new Error('must not bind'); }
    } as any,
    devices: {
      registerVerifiedPeerTracked: async () => { registrations += 1; throw new Error('must not register'); },
      unregisterActiveDevice: async () => false
    } as any,
    token: TOKEN
  });
  const { port } = await service.listen('127.0.0.1', 0); t.after(() => service.close());
  const response = await fetch(`http://127.0.0.1:${port}/v1/device-enrollment/claim`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ principal: { issuer: 'https://issuer.operator-runtime.dev', subject: 'quota-user' }, userCode: 'ABC123' }) });
  assert.equal(response.status, 409);
  assert.equal((await response.json() as any).error.code, 'ACCOUNT_DEVICE_QUOTA');
  assert.equal(registrations, 0);
});

test('new device registration rolls back when serialized account binding fails', async (t) => {
  let rollbacks = 0;
  const peer = { deviceId: DEVICE_ID, fingerprint: 'x'.repeat(43) };
  const service = new RelayControlService({
    hub: {} as any, results: {} as any,
    accounts: {
      resolveOrCreateAccount: async () => ({ accountId: ACCOUNT_A }),
      assertCanBindDevice: async () => undefined,
      bindDevice: async () => { throw new OperatorError('ACCOUNT_DEVICE_QUOTA', 'quota won a race'); }
    } as any,
    enrollments: {
      reserve: async () => ({ enrollmentId: '55555555-5555-4555-8555-555555555555', deviceId: DEVICE_ID }),
      peerForClaim: async () => peer,
      markBound: async () => { throw new Error('must not mark bound'); }
    } as any,
    devices: {
      registerVerifiedPeerTracked: async () => ({ device: peer, created: true }),
      unregisterActiveDevice: async (deviceId: string, fingerprint: string) => { assert.equal(deviceId, DEVICE_ID); assert.equal(fingerprint, peer.fingerprint); rollbacks += 1; return true; }
    } as any,
    token: TOKEN
  });
  const { port } = await service.listen('127.0.0.1', 0); t.after(() => service.close());
  const response = await fetch(`http://127.0.0.1:${port}/v1/device-enrollment/claim`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ principal: { issuer: 'https://issuer.operator-runtime.dev', subject: 'race-user' }, userCode: 'ABC123' }) });
  assert.equal(response.status, 409);
  assert.equal((await response.json() as any).error.code, 'ACCOUNT_DEVICE_QUOTA');
  assert.equal(rollbacks, 1);
});


test('read requests dispatch fresh work even when a stateless MCP client reuses its invocation ID', async (t) => {
  const keyBySeq = new Map<number, string>();
  const completedByKey = new Map<string, any>();
  let dispatchCalls = 0;
  const hub = {
    async recoverIdempotent() { return null; },
    async dispatch(input: any) {
      dispatchCalls += 1;
      keyBySeq.set(dispatchCalls, input.idempotencyKey);
      return { route: { deviceId: DEVICE_ID }, delivery: { id: `fresh-read-${dispatchCalls}`, seq: dispatchCalls } };
    }
  };
  const results = {
    async findByIdempotencyKey(key: string) { return completedByKey.get(key) ?? null; },
    async get(_deviceId: string, seq: number) {
      const key = keyBySeq.get(seq)!;
      const result = {
        deliveryId: `fresh-read-${seq}`,
        result: { ok: true, capability: 'computer.inspect', provider: `fresh-${seq}`, evidence: [], durationMs: 1 },
        replayAuthority: { accountId: ACCOUNT_A, deviceId: DEVICE_ID, generation: 1 }
      };
      completedByKey.set(key, { deviceId: DEVICE_ID, result: { seq, ...result } });
      return result;
    }
  };
  const accounts = {
    async activeMembershipForDevice() {
      return { accountId: ACCOUNT_A, deviceId: DEVICE_ID, authorityGeneration: 1 };
    }
  };
  const service = new RelayControlService({
    hub: hub as any,
    results: results as any,
    accounts: accounts as any,
    token: TOKEN
  });
  const { port } = await service.listen('127.0.0.1', 0);
  t.after(() => service.close());

  for (let index = 0; index < 2; index += 1) {
    const response = await post(port, {
      accountId: ACCOUNT_A,
      action: { ...action(), taskId: 'same-read-request-id' },
      waitMs: 1000
    });
    assert.equal(response.status, 200, await response.text());
  }
  assert.equal(dispatchCalls, 2);
  assert.notEqual(keyBySeq.get(1), keyBySeq.get(2));

  const fresh = await post(port, {
    accountId: ACCOUNT_A,
    action: { ...action(), taskId: 'new-read-request-id' },
    waitMs: 1000
  });
  assert.equal(fresh.status, 200, await fresh.text());
  assert.equal(dispatchCalls, 3);
  assert.notEqual(keyBySeq.get(2), keyBySeq.get(3));
});

test('precondition-guarded public file writes re-evaluate reused stateless invocation IDs', async (t) => {
  const keyBySeq = new Map<number, string>();
  let dispatchCalls = 0;
  const hub = {
    async recoverIdempotent() { return null; },
    async dispatch(input: any) {
      dispatchCalls += 1;
      keyBySeq.set(dispatchCalls, input.idempotencyKey);
      return { route: { deviceId: DEVICE_ID }, delivery: { id: `fresh-write-${dispatchCalls}`, seq: dispatchCalls } };
    }
  };
  const results = {
    async findByIdempotencyKey() { return null; },
    async get(_deviceId: string, seq: number) {
      return {
        deliveryId: `fresh-write-${seq}`,
        result: {
          ok: seq === 1,
          capability: 'file.create',
          provider: 'filesystem.native',
          evidence: [],
          ...(seq === 1 ? {} : { error: { code: 'TARGET_EXISTS', message: 'Target exists.', retryable: false } }),
          durationMs: 1
        },
        replayAuthority: { accountId: ACCOUNT_A, deviceId: DEVICE_ID, generation: 1 }
      };
    }
  };
  const accounts = {
    async activeMembershipForDevice() {
      return { accountId: ACCOUNT_A, deviceId: DEVICE_ID, authorityGeneration: 1 };
    }
  };
  const service = new RelayControlService({
    hub: hub as any,
    results: results as any,
    accounts: accounts as any,
    token: TOKEN
  });
  const { port } = await service.listen('127.0.0.1', 0);
  t.after(() => service.close());

  for (let index = 0; index < 2; index += 1) {
    const response = await post(port, {
      accountId: ACCOUNT_A,
      publicBoundary: true,
      action: { ...writeAction(), taskId: 'same-stateless-request-id' },
      waitMs: 1000
    });
    assert.equal(response.status, 200, await response.text());
  }
  assert.equal(dispatchCalls, 2);
  assert.notEqual(keyBySeq.get(1), keyBySeq.get(2));
});


test('relay control preserves retryable routing failures for the public boundary', async (t) => {
  const service = new RelayControlService({
    hub: {
      recoverIdempotent: async () => null,
      dispatch: async () => {
        throw new OperatorError('ROUTE_DEVICE_OFFLINE', 'private routing detail', { retryable: true });
      }
    } as any,
    results: { findByIdempotencyKey: async () => null, get: async () => null } as any,
    accounts: {} as any,
    token: TOKEN
  });
  const { port } = await service.listen('127.0.0.1', 0);
  t.after(() => service.close());
  const response = await post(port, {
    accountId: ACCOUNT_A,
    action: { ...action(), taskId: 'route-offline-retryable' },
    waitMs: 1000
  });
  assert.equal(response.status, 409);
  const body = await response.json() as any;
  assert.equal(body.error.code, 'ROUTE_DEVICE_OFFLINE');
  assert.equal(body.error.retryable, true);
});
