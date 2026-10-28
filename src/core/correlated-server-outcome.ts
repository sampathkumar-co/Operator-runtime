import crypto from 'node:crypto';
import { canonicalJson } from './action-identity.ts';
import { OperatorError } from './errors.ts';
import {
  createIndependentOutcomeReceipt,
  type IndependentOutcomeReceiptV1,
  type OutcomeCheck,
  type OutcomeContractV1
} from './outcome-contract.ts';

export type SyntheticServerOutcomeKind = 'form' | 'checkout' | 'upload';

export interface CorrelatedServerMutation {
  kind: SyntheticServerOutcomeKind;
  resourceId: string;
  actionId: string;
  resourceGeneration: number;
  nonce: string;
  payloadHash: string;
  artifactHash?: string;
}
export interface CorrelatedServerSnapshot extends CorrelatedServerMutation {
  serverReceiptHash: string;
  committedAt: string;
}

export interface CorrelatedServerExpectation {
  resourceId: string;
  resourceGeneration: number;
  nonce: string;
  payloadHash: string;
  artifactHash?: string;
}

const ID = /^[A-Za-z0-9._:-]{1,256}$/;
const HASH = /^[a-f0-9]{64}$/;

function fail(code: string, message: string): never { throw new OperatorError(code, message); }
function hash(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}
function id(value: unknown, label: string): string {
  if (typeof value !== 'string' || !ID.test(value)) fail('CORRELATED_SERVER_INPUT_INVALID', `${label} is invalid.`);
  return value;
}
function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !HASH.test(value)) fail('CORRELATED_SERVER_INPUT_INVALID', `${label} is invalid.`);
  return value;
}
function generation(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) fail('CORRELATED_SERVER_INPUT_INVALID', 'resourceGeneration is invalid.');
  return Number(value);
}

/** Disposable server-authoritative state used by production-runtime synthetic
 * checks. It exposes no network, authentication, payment, upload, or general
 * remote-operation permission. Browser claims are deliberately not inputs. */
export class InMemoryCorrelatedOutcomeServer {
  readonly #resources = new Map<string, CorrelatedServerSnapshot>();
  readonly #actionIds = new Set<string>();
  readonly #nonces = new Set<string>();
  readonly #now: () => string;

  constructor(now: () => string = () => new Date().toISOString()) { this.#now = now; }

  commit(input: CorrelatedServerMutation): CorrelatedServerSnapshot {
    const kind = input.kind;
    if (!['form', 'checkout', 'upload'].includes(kind)) fail('CORRELATED_SERVER_INPUT_INVALID', 'kind is invalid.');
    const resourceId = id(input.resourceId, 'resourceId');
    const actionId = id(input.actionId, 'actionId');
    const nonce = id(input.nonce, 'nonce');
    const resourceGeneration = generation(input.resourceGeneration);
    const payloadHash = digest(input.payloadHash, 'payloadHash');
    const artifactHash = input.artifactHash === undefined ? undefined : digest(input.artifactHash, 'artifactHash');
    if (kind === 'upload' && !artifactHash) fail('CORRELATED_SERVER_INPUT_INVALID', 'Synthetic upload state requires an artifact hash.');
    if (kind !== 'upload' && artifactHash) fail('CORRELATED_SERVER_INPUT_INVALID', 'Only synthetic upload state may carry an artifact hash.');
    if (this.#actionIds.has(actionId) || this.#nonces.has(nonce)) {
      fail('CORRELATED_SERVER_DUPLICATE_SUBMIT', 'Duplicate action or nonce was rejected before changing server state.');
    }
    const previous = this.#resources.get(resourceId);
    const expectedGeneration = (previous?.resourceGeneration ?? 0) + 1;
    if (resourceGeneration !== expectedGeneration) {
      fail('CORRELATED_SERVER_GENERATION_CONFLICT', 'Resource generation is stale or skips authoritative state.');
    }
    const committedAt = this.#now();
    if (!Number.isFinite(Date.parse(committedAt)) || new Date(committedAt).toISOString() !== committedAt) {
      fail('CORRELATED_SERVER_CLOCK_INVALID', 'Server clock must return canonical ISO time.');
    }
    const base = { kind, resourceId, actionId, resourceGeneration, nonce, payloadHash, ...(artifactHash ? { artifactHash } : {}), committedAt };
    const snapshot = Object.freeze({ ...base, serverReceiptHash: hash(base) });
    this.#resources.set(resourceId, snapshot);
    this.#actionIds.add(actionId);
    this.#nonces.add(nonce);
    return snapshot;
  }

  /** Independent observer seam: returns only an immutable server snapshot.
   * Client DOM text, banners, redirects, and locally manufactured "verified"
   * strings never enter this state. */
  observe(resourceId: string): CorrelatedServerSnapshot | undefined {
    const snapshot = this.#resources.get(id(resourceId, 'resourceId'));
    return snapshot ? Object.freeze({ ...snapshot }) : undefined;
  }
}

export class CorrelatedServerOutcomeObserver {
  readonly #server: InMemoryCorrelatedOutcomeServer;
  readonly #observerId: string;
  readonly #providerId: string;
  readonly #sign: (payload: Buffer) => Promise<string>;

  constructor(input: {
    server: InMemoryCorrelatedOutcomeServer;
    observerId: string;
    providerId: string;
    sign: (payload: Buffer) => Promise<string>;
  }) {
    this.#server = input.server;
    this.#observerId = id(input.observerId, 'observerId');
    this.#providerId = id(input.providerId, 'providerId');
    if (this.#observerId === this.#providerId) fail('OUTCOME_OBSERVER_NOT_INDEPENDENT', 'Provider cannot be its own server observer.');
    this.#sign = input.sign;
  }

  async issueReceipt(input: {
    contract: OutcomeContractV1;
    expectation: CorrelatedServerExpectation;
    dispatchedAt: string;
    observedAt?: string;
  }): Promise<IndependentOutcomeReceiptV1> {
    const expected = input.expectation;
    const resourceId = id(expected.resourceId, 'resourceId');
    const expectedGeneration = generation(expected.resourceGeneration);
    const expectedNonce = id(expected.nonce, 'nonce');
    const expectedPayloadHash = digest(expected.payloadHash, 'payloadHash');
    const expectedArtifactHash = expected.artifactHash === undefined ? undefined : digest(expected.artifactHash, 'artifactHash');
    const observed = this.#server.observe(resourceId);
    const correlated = Boolean(observed && observed.actionId === input.contract.actionId &&
      observed.resourceGeneration === expectedGeneration && observed.nonce === expectedNonce);
    const hashesMatch = Boolean(observed && observed.payloadHash === expectedPayloadHash &&
      observed.artifactHash === expectedArtifactHash);
    const artifactPresent = Boolean(observed && HASH.test(observed.serverReceiptHash));
    const byExpectation = new Map<string, { ok: boolean; evidence: string }>([
      ['server-state-correlated', { ok: correlated, evidence: hash({ resourceId, expectedGeneration, expectedNonce, observed: observed?.serverReceiptHash ?? null }) }],
      ['expected-content-hashes', { ok: hashesMatch, evidence: hash({ expectedPayloadHash, expectedArtifactHash: expectedArtifactHash ?? null, observed: observed?.serverReceiptHash ?? null }) }],
      ['server-receipt-artifact', { ok: artifactPresent, evidence: observed?.serverReceiptHash ?? hash('missing-server-receipt') }]
    ]);
    const checks: OutcomeCheck[] = input.contract.expectations.map(item => {
      const result = byExpectation.get(item.id) ?? { ok: false, evidence: hash({ unsupportedExpectation: item.id }) };
      return {
        expectationId: item.id,
        status: result.ok ? 'PASS' : 'FAIL',
        evidenceDigest: result.evidence,
        evidenceLocation: `artifact:${result.evidence}`
      };
    });
    const verified = checks.every(item => item.status === 'PASS');
    return await createIndependentOutcomeReceipt({
      contract: input.contract,
      providerId: this.#providerId,
      observerId: this.#observerId,
      dispatchedAt: input.dispatchedAt,
      observedAt: input.observedAt ?? observed?.committedAt ?? input.dispatchedAt,
      providerPostStateDigest: observed?.serverReceiptHash ?? hash({ resourceId, state: 'missing' }),
      disposition: verified ? 'VERIFIED' : 'NOT_COMPLETE',
      checks,
      sign: this.#sign,
      nonce: expectedNonce
    });
  }
}
