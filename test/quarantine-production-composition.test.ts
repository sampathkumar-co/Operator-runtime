import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { configureQuarantineProduction } from '../apps/local-agent/src/quarantine-production.ts';

const GENESIS = { count: 0, headMac: '0'.repeat(64) };
const URL_REVIEW = 'https://independent-reviewer.example/reviewer/';
const URL_ANCHOR = 'https://offsite-anchor.example/cas/';
type Harness = Awaited<ReturnType<typeof fixture>>;

async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-live-quarantine-trust-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stateDir = path.join(root, 'state');
  const secrets = path.join(root, 'independent-secrets');
  await fs.mkdir(stateDir);
  await fs.mkdir(secrets);
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  const file = async (name: string, content: string | Buffer) => {
    const f = path.join(secrets, name);
    await fs.writeFile(f, content, { mode: 0o600 });
    await fs.chmod(f, 0o600);
    return f;
  };
  const env = {
    OPERATOR_QUARANTINE_ENABLE: '1',
    OPERATOR_QUARANTINE_REVIEWER_URL: URL_REVIEW,
    OPERATOR_QUARANTINE_ANCHOR_URL: URL_ANCHOR,
    OPERATOR_QUARANTINE_PROVIDER_PUBKEY_FILE:
      await file('provider-public.pem', publicKey.export({ format: 'pem', type: 'spki' }).toString()),
    OPERATOR_QUARANTINE_LEDGER_SECRET_FILE: await file('ledger-mac.bin', crypto.randomBytes(32)),
    OPERATOR_QUARANTINE_REVIEWER_SERVICE_KEY_FILE: await file('reviewer-token', 'r'.repeat(48)),
    OPERATOR_QUARANTINE_ANCHOR_SERVICE_KEY_FILE: await file('anchor-token', 'a'.repeat(48))
  };
  return { root, stateDir, env };
}

function ok(json: unknown) {
  return new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('quarantine production is OFF without a complete independent configuration', async t => {
  const x = await fixture(t);
  assert.equal(await configureQuarantineProduction(x.stateDir, {}), null);
  await assert.rejects(configureQuarantineProduction(x.stateDir,
    { OPERATOR_QUARANTINE_REVIEWER_URL: URL_REVIEW }),
    (e: any) => e?.code === 'QUARANTINE_TRUST_CONFIG_INVALID');
  await assert.rejects(configureQuarantineProduction(x.stateDir,
    { ...x.env, OPERATOR_QUARANTINE_ENABLE: '0' }),
    (e: any) => e?.code === 'QUARANTINE_TRUST_CONFIG_INVALID');
  await assert.rejects(configureQuarantineProduction(x.stateDir,
    { ...x.env, OPERATOR_QUARANTINE_ANCHOR_URL: 'http://localhost:5432' }),
    (e: any) => e?.code === 'QUARANTINE_TRUST_CONFIG_INVALID');
  await assert.rejects(configureQuarantineProduction(x.stateDir,
    { ...x.env, OPERATOR_QUARANTINE_ANCHOR_URL: URL_REVIEW }),
    (e: any) => e?.code === 'QUARANTINE_TRUST_CONFIG_INVALID');
});

test('quarantine provider and MAC secrets may not come from protected restorable runtime state', async t => {
  const x = await fixture(t);
  const inside = path.join(x.stateDir, 'secret');
  await fs.writeFile(inside, crypto.randomBytes(32), { mode: 0o600 });
  await assert.rejects(configureQuarantineProduction(x.stateDir,
    { ...x.env, OPERATOR_QUARANTINE_LEDGER_SECRET_FILE: inside }),
    (e: any) => e?.code === 'QUARANTINE_TRUST_CONFIG_INVALID');
});

test('independent anchor must be reachable and return authentic non-rewinding genesis', async t => {
  const x = await fixture(t);
  let contacted = false;
  const fetcher = (async (url: URL) => {
    contacted = true;
    assert.equal(url.toString(), URL_ANCHOR + 'position');
    return ok({ position: { count: -1, headMac: 'a'.repeat(64) } });
  }) as typeof fetch;
  await assert.rejects(configureQuarantineProduction(x.stateDir, x.env, fetcher),
    (e: any) => e?.code === 'QUARANTINE_ANCHOR_INVALID');
  assert.equal(contacted, true);
  const unavailable = (async () => { throw new Error('independent anchor unavailable'); }) as typeof fetch;
  await assert.rejects(configureQuarantineProduction(x.stateDir, x.env, unavailable),
    (e: any) => e?.code === 'QUARANTINE_TRUST_UNAVAILABLE');
});

test('reviewer verifies the exact request-bound human session via independent HTTPS and does not accept body identity', async t => {
  const x = await fixture(t);
  const seen: Array<{ url: string; auth: string | null; body?: any }> = [];
  let reviewerAllowed = true;
  const fetcher = (async (url: URL, init: RequestInit) => {
    const u = url.toString();
    const h = new Headers(init.headers);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    seen.push({ url: u, auth: h.get('authorization'), body });
    assert.equal(init.redirect, 'error');
    if (u === URL_ANCHOR + 'position') return ok({ position: GENESIS });
    if (u === URL_REVIEW + 'authorize') return ok({
      authorized: reviewerAllowed,
      operatorId: 'human:security-reviewer'
    });
    throw new Error('Unexpected independent authority path');
  }) as typeof fetch;
  const live = await configureQuarantineProduction(x.stateDir, x.env, fetcher);
  assert.ok(live?.adjudicator);
  assert.ok(live?.reviewer);
  const scope = {
    programId: crypto.randomUUID(), targetKey: 'project:synthetic',
    returnedMissionId: crypto.randomUUID()
  };
  const request = (token?: string) => ({
    headers: token ? { 'x-quarantine-review-session': token } : {}
  }) as any;
  await assert.rejects(live.reviewer(scope, request()),
    (e: any) => e?.code === 'QUARANTINE_OPERATOR_UNAUTHORIZED');
  assert.equal(seen.length, 1, 'no call to remote reviewer without a human session');
  const reviewerToken = 'session-proven-by-independent-idp-' + crypto.randomBytes(32).toString('hex');
  const result = await live.reviewer(scope, request(reviewerToken));
  assert.deepEqual(result, { operatorId: 'human:security-reviewer' });
  assert.deepEqual(seen[1]?.body, { kind: 'request-bound-review', scope, session: reviewerToken });
  assert.equal(seen[1]?.auth, 'Bearer ' + 'r'.repeat(48));
  reviewerAllowed = false;
  await assert.rejects(live.reviewer(scope, request(reviewerToken)),
    (e: any) => e?.code === 'QUARANTINE_OPERATOR_UNAUTHORIZED');
});

test('independent trust response fails closed on HTML, unsigned or mismatched reviewer identities', async t => {
  const x = await fixture(t);
  const fetcher = (async (url: URL) =>
    url.toString() === URL_ANCHOR + 'position' ? ok({ position: GENESIS }) :
    new Response('<html>not independently reviewed</html>', { status: 200,
      headers: { 'content-type': 'text/html' } })
  ) as typeof fetch;
  const live = await configureQuarantineProduction(x.stateDir, x.env, fetcher);
  assert.ok(live);
  await assert.rejects(live.reviewer({
    programId: crypto.randomUUID(), targetKey: 'review', returnedMissionId: crypto.randomUUID()
  }, { headers: { 'x-quarantine-review-session': 's'.repeat(64) } } as any),
  (e: any) => e?.code === 'QUARANTINE_TRUST_INVALID');
});
