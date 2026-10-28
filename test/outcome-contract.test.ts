import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createIndependentOutcomeReceipt,
  createHumanTaskOutcomeReport,
  createOutcomeContract,
  createOutcomeRecoveryReport,
  evaluateIndependentOutcome,
  OutcomeReceiptReplayLedger
} from '../src/core/outcome-contract.ts';

const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

function fixture(now = '2026-10-28T10:00:05.000Z') {
  const keys = crypto.generateKeyPairSync('ed25519');
  const contract = createOutcomeContract({
    contractId: 'contract-1', domain: 'browser', actionId: 'action-1', actionDigest: hash('action'),
    planId: 'plan-1', planGeneration: 2, actionGeneration: 3, principalId: 'principal-1',
    deviceId: 'device-1', maxObservationAgeMs: 30_000,
    issuedAt: '2026-10-28T10:00:00.000Z', expiresAt: '2026-10-28T10:01:00.000Z',
    expectations: [
      { id: 'server-record', description: 'Correlated server record exists', required: true },
      { id: 'confirmation', description: 'Confirmation is independently observable', required: true }
    ]
  });
  const sign = async (payload: Buffer) => crypto.sign(null, payload, keys.privateKey).toString('base64');
  const verifySignature = (payload: Buffer, signature: string) =>
    crypto.verify(null, payload, keys.publicKey, Buffer.from(signature, 'base64'));
  return { contract, sign, verifySignature, now };
}

test('C07 versioned receipt distinguishes provider dispatch, post-state and verified user outcome', async () => {
  const f = fixture();
  const receipt = await createIndependentOutcomeReceipt({
    contract: f.contract, providerId: 'browser-provider', observerId: 'server-receipt-observer',
    dispatchedAt: '2026-10-28T10:00:01.000Z', observedAt: '2026-10-28T10:00:04.000Z',
    providerPostStateDigest: hash('post-state'), disposition: 'VERIFIED', sign: f.sign,
    checks: [
      { expectationId: 'confirmation', status: 'PASS', evidenceDigest: hash('confirmation'), evidenceLocation: 'observer:server/confirmation-42' },
      { expectationId: 'server-record', status: 'PASS', evidenceDigest: hash('record'), evidenceLocation: 'receipt:checkout/order-42' }
    ]
  });
  const result = evaluateIndependentOutcome({ contract: f.contract, receipt, now: f.now, verifySignature: f.verifySignature });
  assert.equal(result.verified, true);
  assert.equal(result.disposition, 'VERIFIED');
});

test('C07 rejects self-certification, false banners, stale observations and cross-plan replay', async () => {
  const f = fixture('2026-10-28T10:00:50.000Z');
  await assert.rejects(() => createIndependentOutcomeReceipt({
    contract: f.contract, providerId: 'browser-provider', observerId: 'browser-provider',
    dispatchedAt: '2026-10-28T10:00:01.000Z', observedAt: '2026-10-28T10:00:02.000Z',
    providerPostStateDigest: hash('banner'), disposition: 'VERIFIED', sign: f.sign,
    checks: [
      { expectationId: 'confirmation', status: 'PASS', evidenceDigest: hash('banner'), evidenceLocation: 'observer:browser/banner' },
      { expectationId: 'server-record', status: 'PASS', evidenceDigest: hash('banner'), evidenceLocation: 'observer:browser/banner' }
    ]
  }), (error: any) => error?.code === 'OUTCOME_OBSERVER_NOT_INDEPENDENT');

  const receipt = await createIndependentOutcomeReceipt({
    contract: f.contract, providerId: 'browser-provider', observerId: 'server-observer',
    dispatchedAt: '2026-10-28T10:00:01.000Z', observedAt: '2026-10-28T10:00:02.000Z',
    providerPostStateDigest: hash('post-state'), disposition: 'VERIFIED', sign: f.sign,
    checks: [
      { expectationId: 'confirmation', status: 'PASS', evidenceDigest: hash('confirmation'), evidenceLocation: 'observer:server/confirmation' },
      { expectationId: 'server-record', status: 'PASS', evidenceDigest: hash('record'), evidenceLocation: 'receipt:server/order' }
    ]
  });
  const stale = evaluateIndependentOutcome({ contract: f.contract, receipt, now: f.now, verifySignature: f.verifySignature });
  assert.equal(stale.verified, false);
  assert.ok(stale.failures.some(item => item.code === 'OBSERVATION_STALE'));

  const { schemaVersion: _schemaVersion, ...contractInput } = f.contract;
  const other = createOutcomeContract({ ...contractInput, planGeneration: 3 });
  const rebound = evaluateIndependentOutcome({ contract: other, receipt, now: '2026-10-28T10:00:05.000Z', verifySignature: f.verifySignature });
  assert.equal(rebound.verified, false);
  assert.ok(rebound.failures.some(item => item.code === 'IDENTITY_BINDING_MISMATCH'));
});

test('C07 partial and inconclusive outcomes produce privacy-redacted exact recovery locations', async () => {
  const f = fixture();
  const receipt = await createIndependentOutcomeReceipt({
    contract: f.contract, providerId: 'upload-provider', observerId: 'server-observer',
    dispatchedAt: '2026-10-28T10:00:01.000Z', observedAt: '2026-10-28T10:00:04.000Z',
    providerPostStateDigest: hash('post-state'), disposition: 'INCONCLUSIVE', sign: f.sign,
    checks: [
      { expectationId: 'confirmation', status: 'PASS', evidenceDigest: hash('confirmation'), evidenceLocation: 'observer:server/confirmation' },
      { expectationId: 'server-record', status: 'INCONCLUSIVE', evidenceDigest: hash('truncated'), evidenceLocation: 'artifact:evidence/truncated-42' }
    ]
  });
  const result = evaluateIndependentOutcome({ contract: f.contract, receipt, now: f.now, verifySignature: f.verifySignature });
  assert.equal(result.disposition, 'INCONCLUSIVE');
  const report = createOutcomeRecoveryReport(f.contract, result);
  assert.deepEqual(report.evidenceLocations, ['artifact:evidence/truncated-42']);
  assert.doesNotMatch(JSON.stringify(report), /password|cookie|raw/i);
});

test('C07 uncertain dispatched outcome demands reconciliation and never reports verified', async () => {
  const f = fixture();
  const receipt = await createIndependentOutcomeReceipt({
    contract: f.contract, providerId: 'checkout-provider', observerId: 'server-observer',
    dispatchedAt: '2026-10-28T10:00:01.000Z', observedAt: '2026-10-28T10:00:04.000Z',
    providerPostStateDigest: hash('unknown-post-state'), disposition: 'UNCERTAIN', sign: f.sign,
    checks: [
      { expectationId: 'confirmation', status: 'INCONCLUSIVE', evidenceDigest: hash('timeout'), evidenceLocation: 'observer:server/timeout' },
      { expectationId: 'server-record', status: 'INCONCLUSIVE', evidenceDigest: hash('unknown'), evidenceLocation: 'receipt:checkout/unknown' }
    ]
  });
  const result = evaluateIndependentOutcome({ contract: f.contract, receipt, now: f.now, verifySignature: f.verifySignature });
  assert.equal(result.disposition, 'UNCERTAIN');
  assert.equal(result.verified, false);
  assert.equal(createOutcomeRecoveryReport(f.contract, result).nextAction, 'RECONCILE_DO_NOT_RETRY');
});

test('C07 receipt nonce and identity are durable one-use fences', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-outcome-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const f = fixture();
  const receipt = await createIndependentOutcomeReceipt({
    contract: f.contract, providerId: 'git-provider', observerId: 'git-independent-observer',
    dispatchedAt: '2026-10-28T10:00:01.000Z', observedAt: '2026-10-28T10:00:04.000Z',
    providerPostStateDigest: hash('commit'), disposition: 'VERIFIED', sign: f.sign, nonce: 'nonce-1',
    checks: [
      { expectationId: 'confirmation', status: 'PASS', evidenceDigest: hash('tree'), evidenceLocation: 'observer:git/tree' },
      { expectationId: 'server-record', status: 'PASS', evidenceDigest: hash('commit'), evidenceLocation: 'receipt:git/commit' }
    ]
  });
  const ledger = new OutcomeReceiptReplayLedger(dir);
  await ledger.consume(receipt);
  await assert.rejects(() => new OutcomeReceiptReplayLedger(dir).consume(receipt), (error: any) => error?.code === 'OUTCOME_RECEIPT_REPLAY');
});

test('C07 proof-bearing schemas reject sparse arrays and executable getters', () => {
  const f = fixture();
  const sparse = new Array(1);
  assert.throws(() => createOutcomeContract({ ...f.contract, schemaVersion: undefined, expectations: sparse } as never),
    (error: any) => error?.code === 'OUTCOME_CONTRACT_INVALID');
  const malicious = { ...f.contract } as any;
  delete malicious.schemaVersion;
  Object.defineProperty(malicious, 'principalId', { enumerable: true, get() { throw new Error('executed'); } });
  assert.throws(() => createOutcomeContract(malicious), (error: any) => error?.code === 'OUTCOME_CONTRACT_INVALID');
});

test('C07 human task report is stable, evidence-pack bound and omits raw outcome data', async () => {
  const f = fixture();
  const receipt = await createIndependentOutcomeReceipt({
    contract: f.contract, providerId: 'form-provider', observerId: 'server-observer',
    dispatchedAt: '2026-10-28T10:00:01.000Z', observedAt: '2026-10-28T10:00:04.000Z',
    providerPostStateDigest: hash('form-post-state'), disposition: 'VERIFIED', sign: f.sign,
    checks: [
      { expectationId: 'confirmation', status: 'PASS', evidenceDigest: hash('confirmation'), evidenceLocation: 'observer:server/form' },
      { expectationId: 'server-record', status: 'PASS', evidenceDigest: hash('record'), evidenceLocation: 'receipt:form/submission-42' }
    ]
  });
  const evaluation = evaluateIndependentOutcome({ contract: f.contract, receipt, now: f.now, verifySignature: f.verifySignature });
  const input = { contract: f.contract, evaluation, evidencePackRefs: [`artifact:${hash('pack')}`], createdAt: f.now };
  const first = createHumanTaskOutcomeReport(input);
  const second = createHumanTaskOutcomeReport(input);
  assert.deepEqual(first, second);
  assert.equal(first.verified, true);
  assert.doesNotMatch(JSON.stringify(first), /form-post-state|submission-42|confirmation-42/);
});

test('C07 receipt evaluation rejects executable receipt fields before invoking a getter', async () => {
  const f = fixture();
  const receipt = await createIndependentOutcomeReceipt({
    contract: f.contract, providerId: 'provider', observerId: 'observer',
    dispatchedAt: '2026-10-28T10:00:01.000Z', observedAt: '2026-10-28T10:00:04.000Z',
    providerPostStateDigest: hash('state'), disposition: 'VERIFIED', sign: f.sign,
    checks: [
      { expectationId: 'confirmation', status: 'PASS', evidenceDigest: hash('confirmation'), evidenceLocation: 'observer:server/confirmation' },
      { expectationId: 'server-record', status: 'PASS', evidenceDigest: hash('record'), evidenceLocation: 'receipt:server/record' }
    ]
  });
  const malicious = { ...receipt } as any;
  Object.defineProperty(malicious, 'signature', { enumerable: true, get() { throw new Error('executed'); } });
  assert.throws(() => evaluateIndependentOutcome({ contract: f.contract, receipt: malicious, now: f.now, verifySignature: f.verifySignature }),
    (error: any) => error?.code === 'OUTCOME_RECEIPT_INVALID');
});

test('C05/C07 heterogeneous synthetic domains share one source-executable proof contract without task-specific success magic', async () => {
  const domains = ['browser','application','file-git','build-test','docker','trusted-database','download'] as const;
  for (const [index, domain] of domains.entries()) {
    const keys = crypto.generateKeyPairSync('ed25519');
    const issuedAt = `2026-10-28T10:0${index}:00.000Z`;
    const contract = createOutcomeContract({
      contractId: `contract-${domain}`, domain, actionId: `action-${domain}`, actionDigest: hash(`action-${domain}`),
      planId: 'heterogeneous-plan', planGeneration: 1, actionGeneration: index + 1,
      principalId: 'principal-1', deviceId: 'device-1', maxObservationAgeMs: 30_000,
      issuedAt, expiresAt: `2026-10-28T10:0${index}:30.000Z`,
      expectations: [{ id: 'typed-postcondition', description: `Independent ${domain} postcondition`, required: true }]
    });
    const observedAt = `2026-10-28T10:0${index}:02.000Z`;
    const receipt = await createIndependentOutcomeReceipt({
      contract, providerId: `provider-${domain}`, observerId: `observer-${domain}`,
      dispatchedAt: `2026-10-28T10:0${index}:01.000Z`, observedAt,
      providerPostStateDigest: hash(`post-${domain}`), disposition: 'VERIFIED',
      checks: [{ expectationId: 'typed-postcondition', status: 'PASS', evidenceDigest: hash(`evidence-${domain}`), evidenceLocation: `observer:${domain}/fixture` }],
      sign: async payload => crypto.sign(null, payload, keys.privateKey).toString('base64')
    });
    const result = evaluateIndependentOutcome({
      contract, receipt, now: `2026-10-28T10:0${index}:03.000Z`,
      verifySignature: (payload, signature) => crypto.verify(null, payload, keys.publicKey, Buffer.from(signature, 'base64'))
    });
    assert.equal(result.verified, true, domain);
  }
});
