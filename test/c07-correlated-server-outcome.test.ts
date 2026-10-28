import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { CorrelatedServerOutcomeObserver, InMemoryCorrelatedOutcomeServer } from '../src/core/correlated-server-outcome.ts';
import { createOutcomeContract, evaluateIndependentOutcome } from '../src/core/outcome-contract.ts';

const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

test('C07-05 form, checkout and upload fixtures confirm only correlated server state', async () => {
  const keys = crypto.generateKeyPairSync('ed25519');
  for (const [index, kind] of (['form', 'checkout', 'upload'] as const).entries()) {
    const time = `2026-10-28T10:00:0${index + 2}.000Z`;
    const server = new InMemoryCorrelatedOutcomeServer(() => time);
    const resourceId = `${kind}-resource`;
    const nonce = `${kind}-nonce`;
    const payloadHash = hash(`${kind}-payload`);
    const artifactHash = kind === 'upload' ? hash('disposable-upload-bytes') : undefined;
    server.commit({ kind, resourceId, actionId: `${kind}-action`, resourceGeneration: 1, nonce, payloadHash, ...(artifactHash ? { artifactHash } : {}) });
    assert.throws(() => server.commit({ kind, resourceId, actionId: `${kind}-action`, resourceGeneration: 2, nonce, payloadHash, ...(artifactHash ? { artifactHash } : {}) }),
      (error: any) => error?.code === 'CORRELATED_SERVER_DUPLICATE_SUBMIT');
    const contract = createOutcomeContract({
      contractId: `${kind}-contract`, domain: 'browser', actionId: `${kind}-action`, actionDigest: hash(`${kind}-action-digest`),
      planId: `${kind}-plan`, planGeneration: 1, actionGeneration: 1, principalId: 'principal-test', deviceId: 'device-test',
      expectations: [
        { id: 'server-state-correlated', description: 'Action, generation and nonce match server state.', required: true },
        { id: 'expected-content-hashes', description: 'Expected server hashes match.', required: true },
        { id: 'server-receipt-artifact', description: 'Server receipt artifact exists.', required: true }
      ],
      maxObservationAgeMs: 30_000, issuedAt: '2026-10-28T10:00:00.000Z', expiresAt: '2026-10-28T10:01:00.000Z'
    });
    const observer = new CorrelatedServerOutcomeObserver({
      server, providerId: 'synthetic.browser-provider', observerId: 'trusted.server-observer',
      sign: async payload => crypto.sign(null, payload, keys.privateKey).toString('base64')
    });
    const receipt = await observer.issueReceipt({
      contract, dispatchedAt: '2026-10-28T10:00:01.000Z', observedAt: time,
      expectation: { resourceId, resourceGeneration: 1, nonce, payloadHash, ...(artifactHash ? { artifactHash } : {}) }
    });
    assert.equal(evaluateIndependentOutcome({
      contract, receipt, now: `2026-10-28T10:00:1${index}.000Z`,
      verifySignature: (payload, signature) => crypto.verify(null, payload, keys.publicKey, Buffer.from(signature, 'base64'))
    }).verified, true);
  }
});
test('C07-05 fake browser success cannot replace missing server state or expected hashes', async () => {
  const keys = crypto.generateKeyPairSync('ed25519');
  const server = new InMemoryCorrelatedOutcomeServer(() => '2026-10-28T10:00:02.000Z');
  const contract = createOutcomeContract({
    contractId: 'fake-banner-contract', domain: 'browser', actionId: 'fake-banner-action', actionDigest: hash('action'),
    planId: 'fake-banner-plan', planGeneration: 1, actionGeneration: 1, principalId: 'principal-test', deviceId: 'device-test',
    expectations: [
      { id: 'server-state-correlated', description: 'Server record exists.', required: true },
      { id: 'expected-content-hashes', description: 'Server hash matches.', required: true },
      { id: 'server-receipt-artifact', description: 'Server receipt exists.', required: true }
    ], maxObservationAgeMs: 30_000, issuedAt: '2026-10-28T10:00:00.000Z', expiresAt: '2026-10-28T10:01:00.000Z'
  });
  const observer = new CorrelatedServerOutcomeObserver({
    server, providerId: 'synthetic.browser-provider', observerId: 'trusted.server-observer',
    sign: async payload => crypto.sign(null, payload, keys.privateKey).toString('base64')
  });
  // A client banner reading "verified" is intentionally not accepted by the observer API.
  const receipt = await observer.issueReceipt({
    contract, dispatchedAt: '2026-10-28T10:00:01.000Z', observedAt: '2026-10-28T10:00:02.000Z',
    expectation: { resourceId: 'missing-server-resource', resourceGeneration: 1, nonce: 'fake-banner-nonce', payloadHash: hash('verified') }
  });
  const evaluation = evaluateIndependentOutcome({
    contract, receipt, now: '2026-10-28T10:00:03.000Z',
    verifySignature: (payload, signature) => crypto.verify(null, payload, keys.publicKey, Buffer.from(signature, 'base64'))
  });
  assert.equal(evaluation.verified, false);
  assert.equal(evaluation.disposition, 'NOT_COMPLETE');
});
