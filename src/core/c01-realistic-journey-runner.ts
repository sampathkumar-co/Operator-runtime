import crypto from 'node:crypto';
import { canonicalJson } from './action-identity.ts';
import {
  verifyIndependentCampaignEvidence,
  type IndependentCampaignEvidence
} from './independent-campaign-evidence.ts';

const SHA = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,127}$/;
const FAILURE_STAGES = new Set([
  'none', 'model', 'schema', 'grounding', 'action', 'policy',
  'transport', 'verifier', 'timing', 'uncertain_side_effect', 'unattributed'
]);
const EXACT_SCENARIOS = 50;
const EXACT_DOMAINS = 10;

export interface SealedJourneyCase {
  id: string;
  domain: string;
  objectiveDigest: string;
  fixtureDigest: string;
  oracleDigest: string;
}

export interface SealedJourneyHoldout {
  schemaVersion: 1;
  classification: 'SEALED_EXTERNAL_HOLDOUT';
  suiteDigest: string;
  scenarios: readonly SealedJourneyCase[];
}

export interface RealisticJourneyRunnerInput {
  sourceCommit: string;
  runnerDigest: string;
  environmentDigest: string;
  // Provisioned by the release operator outside the executor/scorer callbacks.
  trustedVerifierPublicKeys: Readonly<Record<string, string>>;
  executorId: string;
  deadlineMs: number;
  holdout: SealedJourneyHoldout;
  signal?: AbortSignal;
  openScenario(input: {
    scenarioId: string;
    domain: string;
    expectedObjectiveDigest: string;
    expectedFixtureDigest: string;
    signal: AbortSignal;
  }): Promise<{
    objective: string;
    objectiveDigest: string;
    fixtureHandle: string;
    fixtureEvidenceDigest: string;
  }>;
  executeScenario(input: {
    scenarioId: string;
    domain: string;
    objective: string;
    fixtureHandle: string;
    signal: AbortSignal;
  }): Promise<{
    executorId: string;
    claimedSuccess: boolean;
    resultEvidenceDigest: string;
  }>;
  scoreScenario(input: {
    scenarioId: string;
    domain: string;
    expectedOracleDigest: string;
    fixtureHandle: string;
    fixtureEvidenceDigest: string;
    resultEvidenceDigest: string;
    signal: AbortSignal;
  }): Promise<{
    verifierId: string;
    verifiedSuccess: boolean;
    failureStage: string;
    unauthorizedEffects: number;
    scoreEvidenceDigest: string;
  }>;
  authenticateEvidence(input: {
    campaignDigest: string;
    requiredEvidenceDigests: readonly string[];
    executorIds: readonly string[];
    verifierIds: readonly string[];
    signal: AbortSignal;
  }): Promise<Omit<IndependentCampaignEvidence, 'trustedVerifierPublicKeys'> | undefined>;
}

export interface RealisticJourneyReport {
  schemaVersion: 1;
  status: 'NOT_RUN' | 'FAIL' | 'PASS';
  sourceCommit: string | null;
  suiteDigest: string | null;
  attempted: number;
  completed: number;
  verifiedSuccesses: number;
  falseCompletions: number;
  unauthorizedEffects: number;
  campaignDigest: string | null;
  authenticatedEvidence: boolean;
  reasons: string[];
  releaseAcceptance: 'NOT_ACCEPTED';
}

function digest(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function invalid(message: string): never {
  throw new Error(`C01_REALISTIC_JOURNEY_INVALID: ${message}`);
}

function plainObject(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    invalid(`${label} must be a plain object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Object.keys(descriptors).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]) ||
      Object.values(descriptors).some((item) => typeof item.get === 'function' || typeof item.set === 'function')) {
    invalid(`${label} fields are invalid`);
  }
  return Object.fromEntries(keys.map((key) => [key, descriptors[key]!.value]));
}

function exactId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !ID.test(value)) invalid(`${label} is invalid`);
  return value;
}

function exactDigest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA.test(value)) invalid(`${label} must be sha256`);
  return value;
}

function validateHoldout(value: unknown): SealedJourneyHoldout {
  const document = plainObject(value, ['schemaVersion', 'classification', 'suiteDigest', 'scenarios'], 'holdout');
  if (document.schemaVersion !== 1 || document.classification !== 'SEALED_EXTERNAL_HOLDOUT') {
    invalid('holdout provenance is not sealed and external');
  }
  const suiteDigest = exactDigest(document.suiteDigest, 'suiteDigest');
  if (!Array.isArray(document.scenarios) || document.scenarios.length !== EXACT_SCENARIOS) {
    invalid('holdout must contain exactly 50 scenarios');
  }
  const ids = new Set<string>();
  const domainCounts = new Map<string, number>();
  const scenarios = document.scenarios.map((raw, index) => {
    const item = plainObject(raw,
      ['id', 'domain', 'objectiveDigest', 'fixtureDigest', 'oracleDigest'], `scenario ${index}`);
    const scenario = {
      id: exactId(item.id, 'scenario id'),
      domain: exactId(item.domain, 'scenario domain'),
      objectiveDigest: exactDigest(item.objectiveDigest, 'objectiveDigest'),
      fixtureDigest: exactDigest(item.fixtureDigest, 'fixtureDigest'),
      oracleDigest: exactDigest(item.oracleDigest, 'oracleDigest')
    };
    if (ids.has(scenario.id)) invalid('scenario ids must be unique');
    ids.add(scenario.id);
    domainCounts.set(scenario.domain, (domainCounts.get(scenario.domain) ?? 0) + 1);
    return Object.freeze(scenario);
  });
  if (domainCounts.size !== EXACT_DOMAINS || [...domainCounts.values()].some((count) => count !== 5)) {
    invalid('holdout must balance five scenarios across ten domains');
  }
  return Object.freeze({ schemaVersion: 1, classification: 'SEALED_EXTERNAL_HOLDOUT',
    suiteDigest, scenarios: Object.freeze(scenarios) });
}

async function bounded<T>(
  callback: (signal: AbortSignal) => Promise<T>,
  deadlineMs: number,
  parent?: AbortSignal
): Promise<T> {
  if (parent?.aborted) throw new Error('CANCELLED');
  const controller = new AbortController();
  let rejectCancel!: (reason: Error) => void;
  const cancelled = new Promise<never>((_, reject) => { rejectCancel = reject; });
  const cancel = () => {
    controller.abort();
    rejectCancel(new Error('CANCELLED'));
  };
  parent?.addEventListener('abort', cancel, { once: true });
  // Cover an abort racing with listener registration, not only entry state.
  if (parent?.aborted) cancel();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('TIMEOUT'));
    }, deadlineMs);
  });
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => callback(controller.signal)), timeout, cancelled
    ]);
    if (parent?.aborted) throw new Error('CANCELLED');
    if (controller.signal.aborted) throw new Error('TIMEOUT');
    return result;
  } finally {
    if (timer) clearTimeout(timer);
    parent?.removeEventListener('abort', cancel);
  }
}

function notRun(reason: string, sourceCommit: string | null = null): RealisticJourneyReport {
  return { schemaVersion: 1, status: 'NOT_RUN', sourceCommit, suiteDigest: null,
    attempted: 0, completed: 0, verifiedSuccesses: 0, falseCompletions: 0,
    unauthorizedEffects: 0, campaignDigest: null, authenticatedEvidence: false,
    reasons: [reason], releaseAcceptance: 'NOT_ACCEPTED' };
}

/**
 * Executes only caller-supplied disposable fixtures. The external scorer keeps
 * oracle bytes outside this source and outside the execution callback. PASS
 * additionally requires an operator-pinned Ed25519 trust root and authenticated
 * bytes for every referenced digest. There are no automatic retries.
 */
export async function runRealisticJourneyCampaign(
  input?: RealisticJourneyRunnerInput
): Promise<RealisticJourneyReport> {
  if (!input) return notRun('No sealed external holdout or authorized fixture runner was supplied.');
  if (input.signal?.aborted) return notRun('Campaign was cancelled before any fixture was opened.');
  if (typeof input.sourceCommit !== 'string' || typeof input.runnerDigest !== 'string' ||
      typeof input.environmentDigest !== 'string' || typeof input.executorId !== 'string' ||
      !COMMIT.test(input.sourceCommit) || !SHA.test(input.runnerDigest) ||
      !SHA.test(input.environmentDigest) || !ID.test(input.executorId) ||
      !Number.isSafeInteger(input.deadlineMs) || input.deadlineMs < 100 || input.deadlineMs > 120_000 ||
      typeof input.openScenario !== 'function' || typeof input.executeScenario !== 'function' ||
      typeof input.scoreScenario !== 'function' || typeof input.authenticateEvidence !== 'function' ||
      !input.trustedVerifierPublicKeys || typeof input.trustedVerifierPublicKeys !== 'object' ||
      Array.isArray(input.trustedVerifierPublicKeys)) {
    invalid('source, runner, environment, executor, deadline and callbacks must be exact');
  }
  const holdout = validateHoldout(input.holdout);
  const results: Array<Record<string, unknown>> = [];
  const verifierIds = new Set<string>();
  const requiredEvidence = new Set<string>([holdout.suiteDigest]);
  let attempted = 0;
  try {
    for (const scenario of holdout.scenarios) {
      attempted += 1;
      const opened = await bounded((signal) => input.openScenario({
        scenarioId: scenario.id, domain: scenario.domain,
        expectedObjectiveDigest: scenario.objectiveDigest,
        expectedFixtureDigest: scenario.fixtureDigest, signal
      }), input.deadlineMs, input.signal);
      const open = plainObject(opened,
        ['objective', 'objectiveDigest', 'fixtureHandle', 'fixtureEvidenceDigest'], 'opened fixture');
      if (typeof open.objective !== 'string' || open.objective.length < 1 || open.objective.length > 4096 ||
          digest(open.objective) !== scenario.objectiveDigest || open.objectiveDigest !== scenario.objectiveDigest ||
          (typeof open.fixtureHandle !== 'string' || !ID.test(open.fixtureHandle)) || open.fixtureEvidenceDigest !== scenario.fixtureDigest) {
        invalid('opened fixture does not match sealed objective and fixture identities');
      }
      const execution = await bounded((signal) => input.executeScenario({
        scenarioId: scenario.id, domain: scenario.domain, objective: open.objective as string,
        fixtureHandle: open.fixtureHandle as string, signal
      }), input.deadlineMs, input.signal);
      const executed = plainObject(execution,
        ['executorId', 'claimedSuccess', 'resultEvidenceDigest'], 'execution result');
      if (executed.executorId !== input.executorId || typeof executed.claimedSuccess !== 'boolean') {
        invalid('execution identity or completion claim is invalid');
      }
      const resultEvidenceDigest = exactDigest(executed.resultEvidenceDigest, 'resultEvidenceDigest');
      const score = await bounded((signal) => input.scoreScenario({
        scenarioId: scenario.id, domain: scenario.domain,
        expectedOracleDigest: scenario.oracleDigest,
        fixtureHandle: open.fixtureHandle as string,
        fixtureEvidenceDigest: scenario.fixtureDigest,
        resultEvidenceDigest, signal
      }), input.deadlineMs, input.signal);
      const scored = plainObject(score,
        ['verifierId', 'verifiedSuccess', 'failureStage', 'unauthorizedEffects', 'scoreEvidenceDigest'],
        'independent score');
      const verifierId = exactId(scored.verifierId, 'verifierId');
      if (verifierId === input.executorId || typeof scored.verifiedSuccess !== 'boolean' ||
          typeof scored.failureStage !== 'string' || !FAILURE_STAGES.has(scored.failureStage) ||
          (scored.verifiedSuccess ? scored.failureStage !== 'none' : scored.failureStage === 'none') ||
          !Number.isSafeInteger(scored.unauthorizedEffects) ||
          (scored.unauthorizedEffects as number) < 0) {
        invalid('independent scorer result is inconsistent or not separated');
      }
      const scoreEvidenceDigest = exactDigest(scored.scoreEvidenceDigest, 'scoreEvidenceDigest');
      verifierIds.add(verifierId);
      for (const evidence of [scenario.objectiveDigest, scenario.fixtureDigest, scenario.oracleDigest,
        resultEvidenceDigest, scoreEvidenceDigest]) requiredEvidence.add(evidence);
      results.push({ scenarioId: scenario.id, domain: scenario.domain,
        objectiveDigest: scenario.objectiveDigest, fixtureDigest: scenario.fixtureDigest,
        oracleDigest: scenario.oracleDigest, executorId: input.executorId, verifierId,
        claimedSuccess: executed.claimedSuccess, verifiedSuccess: scored.verifiedSuccess,
        failureStage: scored.failureStage, unauthorizedEffects: scored.unauthorizedEffects,
        resultEvidenceDigest, scoreEvidenceDigest });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown fixture failure';
    return { schemaVersion: 1, status: 'FAIL', sourceCommit: input.sourceCommit,
      suiteDigest: holdout.suiteDigest, attempted, completed: results.length,
      verifiedSuccesses: results.filter((item) => item.verifiedSuccess === true).length,
      falseCompletions: results.filter((item) => item.claimedSuccess === true && item.verifiedSuccess !== true).length,
      unauthorizedEffects: results.reduce((sum, item) => sum + Number(item.unauthorizedEffects ?? 0), 0),
      campaignDigest: null, authenticatedEvidence: false,
      reasons: [`Fixture campaign stopped without retry: ${message}`], releaseAcceptance: 'NOT_ACCEPTED' };
  }
  const body = { schemaVersion: 1, sourceCommit: input.sourceCommit,
    suiteDigest: holdout.suiteDigest, runnerDigest: input.runnerDigest,
    environmentDigest: input.environmentDigest, executorId: input.executorId, results };
  const campaignDigest = digest(canonicalJson(body));
  let trust: IndependentCampaignEvidence | undefined;
  try {
    const supplied = await bounded(signal => input.authenticateEvidence({ campaignDigest,
      requiredEvidenceDigests: [...requiredEvidence].sort(), executorIds: [input.executorId],
      verifierIds: [...verifierIds].sort(), signal }), input.deadlineMs, input.signal);
    if (supplied) {
      // The evidence supplier must never be allowed to provide its own public keys.
      if (Object.hasOwn(supplied, 'trustedVerifierPublicKeys')) {
        throw new Error('campaign evidence supplier attempted to self-select the verifier trust anchor');
      }
      trust = { ...supplied, trustedVerifierPublicKeys: input.trustedVerifierPublicKeys };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'authentication hook failed';
    return { schemaVersion: 1, status: 'FAIL', sourceCommit: input.sourceCommit,
      suiteDigest: holdout.suiteDigest, attempted, completed: results.length,
      verifiedSuccesses: results.filter((item) => item.verifiedSuccess === true).length,
      falseCompletions: results.filter((item) => item.claimedSuccess === true && item.verifiedSuccess !== true).length,
      unauthorizedEffects: results.reduce((sum, item) => sum + Number(item.unauthorizedEffects ?? 0), 0),
      campaignDigest, authenticatedEvidence: false,
      reasons: [`Independent evidence authentication failed: ${message}`], releaseAcceptance: 'NOT_ACCEPTED' };
  }
  const evidenceReasons = verifyIndependentCampaignEvidence(campaignDigest,
    [...requiredEvidence].sort(), [input.executorId], [...verifierIds].sort(), trust);
  const verifiedSuccesses = results.filter((item) => item.verifiedSuccess === true).length;
  const falseCompletions = results.filter((item) => item.claimedSuccess === true && item.verifiedSuccess !== true).length;
  const unauthorizedEffects = results.reduce((sum, item) => sum + Number(item.unauthorizedEffects ?? 0), 0);
  const outcomeReasons = [
    ...(verifiedSuccesses === EXACT_SCENARIOS ? [] : [`${EXACT_SCENARIOS - verifiedSuccesses} journeys were not independently verified`]),
    ...(unauthorizedEffects === 0 ? [] : [`${unauthorizedEffects} unauthorized effects were recorded`])
  ];
  const reasons = [...evidenceReasons, ...outcomeReasons];
  return { schemaVersion: 1, status: reasons.length === 0 ? 'PASS' : 'FAIL',
    sourceCommit: input.sourceCommit, suiteDigest: holdout.suiteDigest,
    attempted, completed: results.length, verifiedSuccesses, falseCompletions,
    unauthorizedEffects, campaignDigest,
    authenticatedEvidence: evidenceReasons.length === 0,
    reasons, releaseAcceptance: 'NOT_ACCEPTED' };
}

