import crypto from 'node:crypto';
import path from 'node:path';
import { canonicalJson } from './action-identity.ts';
import { readDurableStateText, writeDurableStateText } from './durable-state.ts';
import { withDurableStateLock } from './durable-state-lock.ts';
import { OperatorError } from './errors.ts';

export type OutcomeDomain =
  | 'browser'
  | 'application'
  | 'file-git'
  | 'build-test'
  | 'docker'
  | 'trusted-database'
  | 'download';

export type OutcomeDisposition =
  | 'VERIFIED'
  | 'PARTIAL'
  | 'INCONCLUSIVE'
  | 'UNCERTAIN'
  | 'NOT_COMPLETE';

export interface OutcomeExpectation {
  id: string;
  description: string;
  required: boolean;
}

/** Versioned user-outcome contract. It describes proof requirements only and
 * never grants provider, device, or model authority. */
export interface OutcomeContractV1 {
  schemaVersion: 1;
  contractId: string;
  domain: OutcomeDomain;
  actionId: string;
  actionDigest: string;
  planId: string;
  planGeneration: number;
  actionGeneration: number;
  principalId: string;
  deviceId: string;
  expectations: OutcomeExpectation[];
  maxObservationAgeMs: number;
  issuedAt: string;
  expiresAt: string;
}

export interface OutcomeCheck {
  expectationId: string;
  status: 'PASS' | 'FAIL' | 'INCONCLUSIVE';
  evidenceDigest: string;
  evidenceLocation: string;
}

export interface IndependentOutcomeReceiptV1 {
  schemaVersion: 1;
  receiptId: string;
  nonce: string;
  contractDigest: string;
  actionId: string;
  actionDigest: string;
  planId: string;
  planGeneration: number;
  actionGeneration: number;
  principalId: string;
  deviceId: string;
  providerId: string;
  observerId: string;
  observerIndependent: true;
  dispatchedAt: string;
  observedAt: string;
  providerPostStateDigest: string;
  disposition: OutcomeDisposition;
  checks: OutcomeCheck[];
  signature: string;
}

export interface OutcomeEvaluation {
  disposition: OutcomeDisposition;
  verified: boolean;
  receiptDigest: string;
  failures: Array<{ code: string; evidenceLocation?: string }>;
}

export interface OutcomeRecoveryReport {
  schemaVersion: 1;
  actionId: string;
  disposition: Exclude<OutcomeDisposition, 'VERIFIED'>;
  summary: string;
  nextAction: 'REOBSERVE' | 'RECONCILE_DO_NOT_RETRY' | 'CORRECT_TARGET' | 'COMPLETE_REQUIRED_SUBGOAL';
  evidenceLocations: string[];
}

export interface HumanTaskOutcomeReport {
  schemaVersion: 1;
  reportId: string;
  actionId: string;
  contractId: string;
  disposition: OutcomeDisposition;
  verified: boolean;
  evidencePackRefs: string[];
  receiptDigest: string;
  summary: string;
  createdAt: string;
}

const DIGEST = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9._:-]{1,256}$/;
const LOCATION = /^(artifact|journal|observer|receipt):[A-Za-z0-9._:/-]{1,512}$/;
const MAX_AGE_MS = 10 * 60_000;
const STORE_OPTIONS = {
  maxBytes: 4 * 1024 * 1024,
  errorCode: 'OUTCOME_RECEIPT_LEDGER_CORRUPT',
  invalidMessage: 'Outcome receipt replay ledger is invalid.'
} as const;

type ReceiptUnsigned = Omit<IndependentOutcomeReceiptV1, 'signature'>;

function revalidateContract(contract: OutcomeContractV1): OutcomeContractV1 {
  const { schemaVersion, ...input } = contract;
  if (schemaVersion !== 1) fail('OUTCOME_CONTRACT_INVALID', 'Outcome contract schema version is unsupported.');
  return createOutcomeContract(input);
}

function fail(code: string, message: string): never {
  throw new OperatorError(code, message);
}

function digest(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function canonicalIso(value: unknown, field: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString() !== value) fail('OUTCOME_CONTRACT_INVALID', `${field} must be canonical ISO time.`);
  return value;
}

function literalId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !ID.test(value)) fail('OUTCOME_CONTRACT_INVALID', `${field} is invalid.`);
  return value;
}

function literalDigest(value: unknown, field: string): string {
  if (typeof value !== 'string' || !DIGEST.test(value)) fail('OUTCOME_CONTRACT_INVALID', `${field} is invalid.`);
  return value;
}

function positiveGeneration(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail('OUTCOME_CONTRACT_INVALID', `${field} is invalid.`);
  return value as number;
}

function exactPlainRecord(input: unknown, fields: string[], code = 'OUTCOME_CONTRACT_INVALID'): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)) {
    return fail(code, 'Outcome proof must be an inert plain object.');
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(input).length !== fields.length ||
      Reflect.ownKeys(input).some(key => typeof key !== 'string' || !fields.includes(key)) ||
      fields.some(field => !Object.hasOwn(descriptors, field))) {
    return fail(code, 'Outcome proof has missing or unsupported fields.');
  }
  const snapshot: Record<string, unknown> = Object.create(null);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || !('value' in descriptor)) fail(code, 'Outcome proof contains executable fields.');
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function exactArray(input: unknown, min: number, max: number, code = 'OUTCOME_CONTRACT_INVALID'): unknown[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype ||
      input.length < min || input.length > max || Reflect.ownKeys(input).length !== input.length + 1) {
    return fail(code, 'Outcome proof list must be a dense bounded array.');
  }
  const result: unknown[] = [];
  for (let i = 0; i < input.length; i += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(i));
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) fail(code, 'Outcome proof list has an executable slot.');
    result.push(descriptor.value);
  }
  return result;
}

export function createOutcomeContract(input: Omit<OutcomeContractV1, 'schemaVersion'>): OutcomeContractV1 {
  const raw = exactPlainRecord(input, [
    'contractId','domain','actionId','actionDigest','planId','planGeneration','actionGeneration',
    'principalId','deviceId','expectations','maxObservationAgeMs','issuedAt','expiresAt'
  ]);
  const domains: OutcomeDomain[] = ['browser','application','file-git','build-test','docker','trusted-database','download'];
  if (typeof raw.domain !== 'string' || !domains.includes(raw.domain as OutcomeDomain)) fail('OUTCOME_CONTRACT_INVALID', 'domain is invalid.');
  const expectations = exactArray(raw.expectations, 1, 128).map((item) => {
    const value = exactPlainRecord(item, ['id','description','required']);
    const id = literalId(value.id, 'expectation id');
    if (typeof value.description !== 'string' || !value.description.trim() || value.description.length > 2048 ||
        typeof value.required !== 'boolean') fail('OUTCOME_CONTRACT_INVALID', 'Expectation is invalid.');
    return Object.freeze({ id, description: value.description, required: value.required });
  });
  if (new Set(expectations.map(item => item.id)).size !== expectations.length) fail('OUTCOME_CONTRACT_INVALID', 'Expectation ids must be unique.');
  if (!expectations.some(item => item.required)) fail('OUTCOME_CONTRACT_INVALID', 'At least one outcome expectation must be required.');
  if (!Number.isSafeInteger(raw.maxObservationAgeMs) || (raw.maxObservationAgeMs as number) < 1_000 ||
      (raw.maxObservationAgeMs as number) > MAX_AGE_MS) fail('OUTCOME_CONTRACT_INVALID', 'Observation freshness policy is invalid.');
  const issuedAt = canonicalIso(raw.issuedAt, 'issuedAt');
  const expiresAt = canonicalIso(raw.expiresAt, 'expiresAt');
  if (Date.parse(expiresAt) <= Date.parse(issuedAt)) fail('OUTCOME_CONTRACT_INVALID', 'Outcome contract must expire after issuance.');
  return Object.freeze({
    schemaVersion: 1,
    contractId: literalId(raw.contractId, 'contractId'),
    domain: raw.domain as OutcomeDomain,
    actionId: literalId(raw.actionId, 'actionId'),
    actionDigest: literalDigest(raw.actionDigest, 'actionDigest'),
    planId: literalId(raw.planId, 'planId'),
    planGeneration: positiveGeneration(raw.planGeneration, 'planGeneration'),
    actionGeneration: positiveGeneration(raw.actionGeneration, 'actionGeneration'),
    principalId: literalId(raw.principalId, 'principalId'),
    deviceId: literalId(raw.deviceId, 'deviceId'),
    expectations: Object.freeze(expectations) as unknown as OutcomeExpectation[],
    maxObservationAgeMs: raw.maxObservationAgeMs as number,
    issuedAt,
    expiresAt
  });
}

export async function createIndependentOutcomeReceipt(input: {
  contract: OutcomeContractV1;
  providerId: string;
  observerId: string;
  dispatchedAt: string;
  observedAt: string;
  providerPostStateDigest: string;
  disposition: OutcomeDisposition;
  checks: OutcomeCheck[];
  sign: (payload: Buffer) => Promise<string>;
  nonce?: string;
}): Promise<IndependentOutcomeReceiptV1> {
  const contract = revalidateContract(input.contract);
  const checks = normalizeChecks(input.checks, contract);
  const unsigned: ReceiptUnsigned = {
    schemaVersion: 1,
    receiptId: crypto.randomUUID(),
    nonce: literalId(input.nonce ?? crypto.randomUUID(), 'nonce'),
    contractDigest: digest(contract),
    actionId: contract.actionId,
    actionDigest: contract.actionDigest,
    planId: contract.planId,
    planGeneration: contract.planGeneration,
    actionGeneration: contract.actionGeneration,
    principalId: contract.principalId,
    deviceId: contract.deviceId,
    providerId: literalId(input.providerId, 'providerId'),
    observerId: literalId(input.observerId, 'observerId'),
    observerIndependent: true,
    dispatchedAt: canonicalIso(input.dispatchedAt, 'dispatchedAt'),
    observedAt: canonicalIso(input.observedAt, 'observedAt'),
    providerPostStateDigest: literalDigest(input.providerPostStateDigest, 'providerPostStateDigest'),
    disposition: input.disposition,
    checks
  };
  if (unsigned.providerId === unsigned.observerId) fail('OUTCOME_OBSERVER_NOT_INDEPENDENT', 'Provider cannot certify its own user outcome.');
  const derived = deriveDisposition(contract, checks);
  const allowedDisposition = input.disposition === derived ||
    (input.disposition === 'UNCERTAIN' && checks.some(check => check.status === 'INCONCLUSIVE'));
  if (!allowedDisposition) fail('OUTCOME_DISPOSITION_MISMATCH', 'Claimed disposition does not match independent checks.');
  if (Date.parse(unsigned.observedAt) < Date.parse(unsigned.dispatchedAt)) fail('OUTCOME_RECEIPT_INVALID', 'Observation predates dispatch.');
  const signature = await input.sign(Buffer.from(canonicalJson(unsigned), 'utf8'));
  if (typeof signature !== 'string' || signature.length < 32 || signature.length > 4096) fail('OUTCOME_SIGNATURE_INVALID', 'Observer signature is invalid.');
  return Object.freeze({ ...unsigned, signature });
}

function normalizeChecks(input: unknown, contract: OutcomeContractV1): OutcomeCheck[] {
  const expectations = new Set(contract.expectations.map(item => item.id));
  const checks = exactArray(input, 1, 128, 'OUTCOME_RECEIPT_INVALID').map((item) => {
    const raw = exactPlainRecord(item, ['expectationId','status','evidenceDigest','evidenceLocation'], 'OUTCOME_RECEIPT_INVALID');
    const expectationId = literalId(raw.expectationId, 'expectationId');
    if (!expectations.has(expectationId) || !['PASS','FAIL','INCONCLUSIVE'].includes(raw.status as string) ||
        typeof raw.evidenceLocation !== 'string' || !LOCATION.test(raw.evidenceLocation)) {
      fail('OUTCOME_RECEIPT_INVALID', 'Outcome check is not contract-bound or its evidence location is unsafe.');
    }
    return Object.freeze({
      expectationId,
      status: raw.status as OutcomeCheck['status'],
      evidenceDigest: literalDigest(raw.evidenceDigest, 'evidenceDigest'),
      evidenceLocation: raw.evidenceLocation
    });
  });
  if (new Set(checks.map(item => item.expectationId)).size !== checks.length) fail('OUTCOME_RECEIPT_INVALID', 'Outcome checks must be unique.');
  return checks.sort((a, b) => a.expectationId.localeCompare(b.expectationId));
}

function deriveDisposition(contract: OutcomeContractV1, checks: OutcomeCheck[]): OutcomeDisposition {
  const byId = new Map(checks.map(item => [item.expectationId, item]));
  const required = contract.expectations.filter(item => item.required).map(item => byId.get(item.id));
  if (required.some(item => !item || item.status === 'INCONCLUSIVE')) return 'INCONCLUSIVE';
  if (required.some(item => item?.status === 'FAIL')) return 'NOT_COMPLETE';
  const optional = contract.expectations.filter(item => !item.required).map(item => byId.get(item.id));
  if (optional.some(item => !item || item.status !== 'PASS')) return 'PARTIAL';
  return 'VERIFIED';
}

export function evaluateIndependentOutcome(input: {
  contract: OutcomeContractV1;
  receipt: IndependentOutcomeReceiptV1;
  now?: string;
  verifySignature: (payload: Buffer, signature: string) => boolean;
}): OutcomeEvaluation {
  const contract = revalidateContract(input.contract);
  const rawReceipt = exactPlainRecord(input.receipt, [
    'schemaVersion','receiptId','nonce','contractDigest','actionId','actionDigest','planId',
    'planGeneration','actionGeneration','principalId','deviceId','providerId','observerId',
    'observerIndependent','dispatchedAt','observedAt','providerPostStateDigest','disposition','checks','signature'
  ], 'OUTCOME_RECEIPT_INVALID');
  const receipt = rawReceipt as unknown as IndependentOutcomeReceiptV1;
  const failures: OutcomeEvaluation['failures'] = [];
  const unsigned: Partial<IndependentOutcomeReceiptV1> = { ...receipt };
  delete unsigned.signature;
  const bindingsMatch = receipt.schemaVersion === 1 && receipt.contractDigest === digest(contract) &&
    receipt.actionId === contract.actionId && receipt.actionDigest === contract.actionDigest &&
    receipt.planId === contract.planId && receipt.planGeneration === contract.planGeneration &&
    receipt.actionGeneration === contract.actionGeneration && receipt.principalId === contract.principalId &&
    receipt.deviceId === contract.deviceId && receipt.observerIndependent === true && receipt.providerId !== receipt.observerId;
  if (!bindingsMatch) failures.push({ code: 'IDENTITY_BINDING_MISMATCH' });
  if (!ID.test(receipt.receiptId ?? '') || !ID.test(receipt.nonce ?? '') ||
      !ID.test(receipt.providerId ?? '') || !ID.test(receipt.observerId ?? '') ||
      !DIGEST.test(receipt.contractDigest ?? '') || !DIGEST.test(receipt.actionDigest ?? '') ||
      !['VERIFIED','PARTIAL','INCONCLUSIVE','UNCERTAIN','NOT_COMPLETE'].includes(receipt.disposition as string) ||
      !Number.isSafeInteger(receipt.planGeneration) || receipt.planGeneration < 1 ||
      !Number.isSafeInteger(receipt.actionGeneration) || receipt.actionGeneration < 1) {
    failures.push({ code: 'RECEIPT_SCHEMA_INVALID' });
  }
  let checks: OutcomeCheck[] = [];
  try { checks = normalizeChecks(receipt.checks, contract); }
  catch { failures.push({ code: 'CHECK_CONTRACT_INVALID' }); }
  const now = Date.parse(canonicalIso(input.now ?? new Date().toISOString(), 'now'));
  const observedAt = Date.parse(receipt.observedAt);
  if (!Number.isFinite(observedAt) || observedAt < Date.parse(receipt.dispatchedAt) ||
      observedAt < Date.parse(contract.issuedAt) || observedAt > Date.parse(contract.expiresAt) ||
      now - observedAt > contract.maxObservationAgeMs || now < observedAt) failures.push({ code: 'OBSERVATION_STALE' });
  if (!DIGEST.test(receipt.providerPostStateDigest ?? '')) failures.push({ code: 'POST_STATE_DIGEST_INVALID' });
  let signatureValid = false;
  try {
    signatureValid = typeof receipt.signature === 'string' && receipt.signature.length >= 32 && receipt.signature.length <= 4096 &&
      input.verifySignature(Buffer.from(canonicalJson(unsigned), 'utf8'), receipt.signature) === true;
  } catch { /* verifier errors never authorize an outcome */ }
  if (!signatureValid) failures.push({ code: 'SIGNATURE_INVALID' });
  const checksDerived = checks.length ? deriveDisposition(contract, checks) : 'INCONCLUSIVE';
  const derived: OutcomeDisposition = receipt.disposition === 'UNCERTAIN' &&
    checks.some(check => check.status === 'INCONCLUSIVE') ? 'UNCERTAIN' : checksDerived;
  if (receipt.disposition !== derived) failures.push({ code: 'DISPOSITION_MISMATCH' });
  for (const check of checks) if (check.status !== 'PASS') failures.push({ code: `EXPECTATION_${check.status}`, evidenceLocation: check.evidenceLocation });
  const verified = failures.length === 0 && derived === 'VERIFIED';
  return { disposition: verified ? 'VERIFIED' : derived === 'VERIFIED' ? 'INCONCLUSIVE' : derived,
    verified, receiptDigest: digest(receipt), failures };
}

/** Durable one-use fence. Consume only after signature/binding evaluation; an
 * uncertain mutation never obtains a second outcome receipt for replay. */
export class OutcomeReceiptReplayLedger {
  readonly #file: string;
  constructor(stateDir: string) {
    if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir)) fail('OUTCOME_LEDGER_CONFIG_INVALID', 'Outcome ledger needs an absolute state directory.');
    this.#file = path.join(path.resolve(stateDir), 'outcome-receipts-v1.json');
  }
  async consume(receipt: IndependentOutcomeReceiptV1): Promise<void> {
    if (!receipt || typeof receipt.receiptId !== 'string' || typeof receipt.nonce !== 'string') fail('OUTCOME_RECEIPT_INVALID', 'Receipt identity is invalid.');
    await withDurableStateLock(this.#file, async () => {
      let state: { schemaVersion: 1; consumed: Array<{ receiptId: string; nonce: string; digest: string }> } = { schemaVersion: 1, consumed: [] };
      try { state = JSON.parse(await readDurableStateText(this.#file, STORE_OPTIONS)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (state?.schemaVersion !== 1 || !Array.isArray(state.consumed) || state.consumed.length > 20_000) fail('OUTCOME_RECEIPT_LEDGER_CORRUPT', 'Outcome replay ledger shape is invalid.');
      if (state.consumed.some(item => item.receiptId === receipt.receiptId || item.nonce === receipt.nonce)) fail('OUTCOME_RECEIPT_REPLAY', 'Outcome receipt or nonce was already consumed.');
      state.consumed.push({ receiptId: receipt.receiptId, nonce: receipt.nonce, digest: digest(receipt) });
      await writeDurableStateText(this.#file, JSON.stringify(state), STORE_OPTIONS);
    });
  }
}

export function createOutcomeRecoveryReport(contract: OutcomeContractV1, evaluation: OutcomeEvaluation): OutcomeRecoveryReport {
  if (evaluation.verified || evaluation.disposition === 'VERIFIED') fail('OUTCOME_RECOVERY_NOT_REQUIRED', 'Verified outcomes do not require recovery.');
  const evidenceLocations = [...new Set(evaluation.failures.map(item => item.evidenceLocation).filter((item): item is string => Boolean(item && LOCATION.test(item))))].sort();
  const stale = evaluation.failures.some(item => item.code === 'OBSERVATION_STALE');
  const binding = evaluation.failures.some(item => item.code === 'IDENTITY_BINDING_MISMATCH');
  const uncertain = evaluation.disposition === 'UNCERTAIN' || evaluation.failures.some(item => item.code === 'SIGNATURE_INVALID');
  return Object.freeze({
    schemaVersion: 1,
    actionId: contract.actionId,
    disposition: evaluation.disposition as Exclude<OutcomeDisposition, 'VERIFIED'>,
    summary: binding ? 'Evidence belongs to a different action, plan, principal, device, or generation.'
      : stale ? 'The independent observation is stale or outside the authorized observation window.'
      : uncertain ? 'The dispatched side effect is unresolved; reconcile before any retry.'
      : 'One or more required user outcomes were not independently established.',
    nextAction: uncertain ? 'RECONCILE_DO_NOT_RETRY' : binding ? 'CORRECT_TARGET' : stale ? 'REOBSERVE' : 'COMPLETE_REQUIRED_SUBGOAL',
    evidenceLocations
  });
}

/** Stable, bounded human-facing result. References point to evidence packs;
 * raw page text, paths, cookies, form values and database rows are excluded. */
export function createHumanTaskOutcomeReport(input: {
  contract: OutcomeContractV1;
  evaluation: OutcomeEvaluation;
  evidencePackRefs: string[];
  createdAt?: string;
}): HumanTaskOutcomeReport {
  const contract = revalidateContract(input.contract);
  const refs = exactArray(input.evidencePackRefs, 1, 128).map((value) => {
    if (typeof value !== 'string' || !/^artifact:[a-f0-9]{64}$/.test(value)) {
      fail('OUTCOME_REPORT_INVALID', 'Human outcome report requires stable evidence-pack artifact references.');
    }
    return value;
  });
  const evidencePackRefs = [...new Set(refs)].sort();
  const createdAt = canonicalIso(input.createdAt ?? new Date().toISOString(), 'createdAt');
  const summary = input.evaluation.verified
    ? 'All required user outcomes were established by a fresh independent receipt.'
    : input.evaluation.disposition === 'UNCERTAIN'
      ? 'A dispatched side effect remains uncertain; reconcile it before retrying.'
      : 'The requested user outcome was not fully established; inspect the referenced evidence pack.';
  const identity = {
    schemaVersion: 1 as const,
    actionId: contract.actionId,
    contractId: contract.contractId,
    disposition: input.evaluation.disposition,
    verified: input.evaluation.verified,
    evidencePackRefs,
    receiptDigest: literalDigest(input.evaluation.receiptDigest, 'receiptDigest'),
    summary,
    createdAt
  };
  return Object.freeze({ ...identity, reportId: digest(identity) });
}
