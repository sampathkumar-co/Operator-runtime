import crypto from 'node:crypto';
import { canonicalJson } from './action-identity.ts';
import { OperatorError } from './errors.ts';

/**
 * C01 Lane A: a model-only decision on a frozen observation.
 * This runner has no runtime/provider interface and no capability to dispatch
 * any action. A caller-supplied model adapter is the only inference entry.
 * The oracle answer is deliberately never passed to that adapter.
 */
export interface FrozenModelChoice {
  id: string;
  observation: unknown;
  observationSha256: string;
  allowedActionIds: string[];
  expectedActionId: string;
  oracleSha256: string;
}
export interface FrozenModelChoiceResult {
  id: string;
  observationSha256: string;
  oracleSha256: string;
  proposedActionId?: string;
  decisionSha256?: string;
  matchedOracle: boolean;
  failureStage: 'none' | 'model' | 'schema' | 'timing';
}
export interface FrozenModelChoiceReport {
  schemaVersion: 1;
  mode: 'MODEL_ONLY_NO_MECORD_DISPATCH';
  sourceCommit: string;
  modelId: string;
  modelConfigDigest: string;
  scenarios: number;
  oracleMatches: number;
  results: FrozenModelChoiceResult[];
  /** The caller's model identity is not independently authenticated. */
  physicalAcceptance: 'NOT_VERIFIED';
  releaseAcceptance: 'NOT_ACCEPTED';
  reportSha256: string;
}

const SHA = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const ID = /^[A-Za-z0-9._:-]{1,128}$/;
function invalid(message: string): OperatorError {
  return new OperatorError('C01_FROZEN_MODEL_LANE_INVALID', message);
}
function digest(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}
function exactId(value: unknown, name: string): string {
  if (typeof value !== 'string' || !ID.test(value)) throw invalid(name + ' is invalid.');
  return value;
}
function assertJsonData(value: unknown, depth = 0, seen = new Set<object>()): void {
  if (depth > 16) throw invalid('Frozen observation exceeds JSON nesting boundary.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object') throw invalid('Frozen observation must contain JSON values only.');
  if (seen.has(value)) throw invalid('Frozen observation must not contain cycles.');
  seen.add(value);
  if (Array.isArray(value)) {
    if (value.length > 2000) throw invalid('Frozen observation array is too large.');
    for (const element of value) assertJsonData(element, depth + 1, seen);
  } else {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw invalid('Frozen observation must be a plain JSON object.');
    }
    const entries = Object.getOwnPropertyDescriptors(value);
    if (Object.keys(entries).length > 500) throw invalid('Frozen observation has too many fields.');
    for (const descriptor of Object.values(entries)) {
      if (!('value' in descriptor)) throw invalid('Frozen observation cannot contain getters.');
      assertJsonData(descriptor.value, depth + 1, seen);
    }
  }
  seen.delete(value);
}
function validateChoice(input: FrozenModelChoice): FrozenModelChoice {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('Choice is invalid.');
  const id = exactId(input.id, 'id');
  if (!Array.isArray(input.allowedActionIds) || input.allowedActionIds.length < 2
    || input.allowedActionIds.length > 40) throw invalid('Choice action list must have 2..40 alternatives.');
  const options = input.allowedActionIds.map((x: unknown) => exactId(x, 'allowedActionId'));
  if (new Set(options).size !== options.length) throw invalid('Choice action IDs must be unique.');
  const correct = exactId(input.expectedActionId, 'expectedActionId');
  if (!options.includes(correct)) throw invalid('Oracle answer must be among allowed alternatives.');
  if (typeof input.observationSha256 !== 'string' || !SHA.test(input.observationSha256)
    || typeof input.oracleSha256 !== 'string' || !SHA.test(input.oracleSha256)) {
    throw invalid('Frozen observation/oracle digests are missing.');
  }
  if (input.observation === null || typeof input.observation !== 'object'
    || Array.isArray(input.observation)) throw invalid('Observation must be a JSON object.');
  assertJsonData(input.observation);
  let observationJson: string;
  try { observationJson = canonicalJson(input.observation); }
  catch { throw invalid('Observation is not canonical JSON.'); }
  if (Buffer.byteLength(observationJson, 'utf8') > 128 * 1024) throw invalid('Observation exceeds privacy/size boundary.');
  if (digest(input.observation) !== input.observationSha256
    || digest({ expectedActionId: correct }) !== input.oracleSha256) {
    throw invalid('Frozen observation/oracle content differs from its digest.');
  }
  return { id, observation: JSON.parse(observationJson), observationSha256: input.observationSha256,
    allowedActionIds: options, expectedActionId: correct, oracleSha256: input.oracleSha256 };
}
function immutableCopy<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) immutableCopy(child);
  }
  return value;
}
export async function runFrozenModelDecisionLane(input: {
  sourceCommit: string;
  modelId: string;
  modelConfigDigest: string;
  choices: FrozenModelChoice[];
  decide: (observation: Readonly<Record<string, unknown>>, allowedActionIds: readonly string[],
    signal: AbortSignal) => Promise<unknown> | unknown;
  timeoutMs?: number;
}): Promise<FrozenModelChoiceReport> {
  if (!input || typeof input !== 'object' || !COMMIT.test(input.sourceCommit)
    || !SHA.test(input.modelConfigDigest) || typeof input.decide !== 'function') throw invalid('Model lane provenance is invalid.');
  const modelId = exactId(input.modelId, 'modelId');
  if (modelId === 'scripted' || modelId === 'none') throw invalid('Model adapter must have named model provenance.');
  if (!Array.isArray(input.choices) || !input.choices.length || input.choices.length > 125) {
    throw invalid('Frozen suite must have 1..125 choices.');
  }
  const choices = input.choices.map(validateChoice);
  if (new Set(choices.map(choice => choice.id)).size !== choices.length) throw invalid('Frozen suite IDs must be unique.');
  const timeoutMs = input.timeoutMs ?? 5000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 30000) throw invalid('Model timeout is invalid.');
  const results: FrozenModelChoiceResult[] = [];
  for (const choice of choices) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let proposed: unknown;
    let failed: FrozenModelChoiceResult['failureStage'] = 'none';
    try {
      const observation = immutableCopy(choice.observation as Record<string, unknown>);
      const allowed = immutableCopy([...choice.allowedActionIds]);
      proposed = await Promise.race([
        Promise.resolve().then(() => input.decide(observation, allowed, controller.signal)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new Error('MODEL_TIMEOUT')); }, timeoutMs);
        })
      ]);
      if (typeof proposed !== 'string' || !choice.allowedActionIds.includes(proposed)) failed = 'schema';
    } catch (error) {
      failed = error instanceof Error && error.message === 'MODEL_TIMEOUT' ? 'timing' : 'model';
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      controller.abort();
    }
    const valid = failed === 'none' && typeof proposed === 'string';
    results.push({
      id: choice.id, observationSha256: choice.observationSha256, oracleSha256: choice.oracleSha256,
      ...(valid ? { proposedActionId: proposed as string, decisionSha256: digest({ proposedActionId: proposed }) } : {}),
      matchedOracle: valid && proposed === choice.expectedActionId, failureStage: failed
    });
  }
  const report = {
    schemaVersion: 1 as const, mode: 'MODEL_ONLY_NO_MECORD_DISPATCH' as const,
    sourceCommit: input.sourceCommit, modelId, modelConfigDigest: input.modelConfigDigest,
    scenarios: choices.length, oracleMatches: results.filter(x => x.matchedOracle).length, results,
    physicalAcceptance: 'NOT_VERIFIED' as const, releaseAcceptance: 'NOT_ACCEPTED' as const
  };
  return { ...report, reportSha256: digest(report) };
}
