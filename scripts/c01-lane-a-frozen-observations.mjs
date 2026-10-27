import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { buildWave0EvaluationReport } from './wave0-evaluation.mjs';
import { requireFrozenEvaluationCases } from './c01-inert-evaluation-input.mjs';

const SHA = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const ID = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
const OPERATIONS = new Set(['click', 'type', 'select', 'scroll', 'done']);
const sha256 = text => crypto.createHash('sha256').update(text).digest('hex');
function invalid(why) { throw new Error('C01_LANE_A_INVALID: ' + why); }
function own(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) &&
    Reflect.ownKeys(value).every(key => typeof key === 'string' && keys.includes(key)) &&
    Object.values(Object.getOwnPropertyDescriptors(value)).every(d => 'value' in d && d.enumerable);
}
function jsonValue(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (value.length > 4096) invalid('observation array too long');
    return value.map(jsonValue);
  }
  if (!own(value, Reflect.ownKeys(value))) invalid('observation contains non-JSON structure');
  const output = Object.create(null);
  for (const key of Object.keys(value).sort()) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') invalid('observation key forbidden');
    output[key] = jsonValue(value[key]);
  }
  return output;
}
function stable(value) { return JSON.stringify(jsonValue(value)); }
function freezeDeep(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}
function parseBoundedJson(raw, maxBytes, label) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > maxBytes || raw.length === 0) {
    invalid(label + ' must be bounded immutable JSON text');
  }
  try { return jsonValue(JSON.parse(raw)); } catch { invalid(label + ' must be valid inert JSON'); }
}
function decision(raw) {
  if (!own(raw, ['operation', 'targetId', 'value'])) invalid('model decision has hidden or extra fields');
  if (!OPERATIONS.has(raw.operation)) invalid('model decision operation unsupported');
  const keys = Object.keys(raw).sort().join(',');
  if (raw.operation === 'done') {
    if (keys !== 'operation') invalid('done decision must not include tool authority');
  } else if (raw.operation === 'type' || raw.operation === 'select') {
    if (keys !== 'operation,targetId,value' || typeof raw.value !== 'string' || raw.value.length > 1024) {
      invalid('type/select require a bounded text value');
    }
  } else if (keys !== 'operation,targetId') {
    invalid('operation requires only a target identity');
  }
  if (raw.operation !== 'done' && (typeof raw.targetId !== 'string' ||
      raw.targetId.length > 128 || !ID.test(raw.targetId))) {
    invalid('targetId must be a frozen observation identity');
  }
  return stable(raw);
}
function checkCase(item) {
  if (!own(item, ['scenarioId', 'scenarioVersion', 'seed', 'observationJson', 'acceptableDecisionsJson'])) {
    invalid('fixture has extra or executable fields');
  }
  for (const field of ['scenarioId', 'scenarioVersion']) {
    if (typeof item[field] !== 'string' || !ID.test(item[field])) invalid(field + ' invalid');
  }
  if (!Number.isSafeInteger(item.seed) || item.seed < 0) invalid('seed invalid');
  const observation = parseBoundedJson(item.observationJson, 64 * 1024, 'observation');
  const expected = parseBoundedJson(item.acceptableDecisionsJson, 32 * 1024, 'answer key');
  if (!Array.isArray(expected) || expected.length < 1 || expected.length > 16) invalid('answer set invalid');
  const accepted = new Set(expected.map(decision));
  if (accepted.size !== expected.length) invalid('duplicate acceptable decision');
  return { ...item, observation: freezeDeep(observation), accepted,
    oracleDigest: sha256(stable(expected)), environmentDigest: sha256(stable(observation)) };
}
function validDigest(text, name) { if (typeof text !== 'string' || !SHA.test(text)) invalid(name + ' invalid'); }
function validId(text, name) { if (typeof text !== 'string' || !ID.test(text)) invalid(name + ' invalid'); }

/**
 * Lane A: test model decisions on frozen observation JSON, independent of the
 * Mecord capability kernel. Only observation/identity reach the model callback:
 * gold answers remain in the local scorer. Caller-provided adapters and claims
 * are NOT authenticated, and must never be promoted to physical certification.
 * This module performs no provider dispatch or authorization.
 */
export async function runLaneAFrozenDecisions({
  sourceCommit, model, modelConfigDigest, runnerDigest, fixtures, decide, timeoutMs = 10_000
}) {
  if (typeof sourceCommit !== 'string' || !COMMIT.test(sourceCommit)) invalid('source SHA invalid');
  validId(model, 'model');
  if (model === 'scripted' || model === 'none') invalid('a named model is required');
  validDigest(modelConfigDigest, 'model configuration digest');
  validDigest(runnerDigest, 'runner digest');
  requireFrozenEvaluationCases(fixtures, 1, 125, invalid, 'frozen fixtures',
    ['scenarioId', 'scenarioVersion', 'seed', 'observationJson', 'acceptableDecisionsJson']);
  if (typeof decide !== 'function') invalid('model-only decision callback required');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 25 || timeoutMs > 30_000) invalid('timeout invalid');
  const cases = fixtures.map(checkCase);
  const identities = new Set();
  for (const item of cases) {
    const id = item.scenarioId + ':' + item.scenarioVersion + ':' + item.seed;
    if (identities.has(id)) invalid('duplicate frozen scenario identity');
    identities.add(id);
  }
  const records = [];
  for (const item of cases) {
    let modelAnswer = null, costMicros = 0, failureStage = 'unattributed';
    let expired = false, timer;
    const controller = new AbortController();
    const started = performance.now();
    try {
      const output = await Promise.race([
        Promise.resolve().then(() => decide({
          model, scenarioId: item.scenarioId, scenarioVersion: item.scenarioVersion,
          seed: item.seed, observation: item.observation, signal: controller.signal
        })),
        new Promise((_, reject) => {
          timer = setTimeout(() => { expired = true; controller.abort(); reject(new Error('MODEL_DEADLINE')); }, timeoutMs);
        })
      ]);
      // Model syntax/contracts are scored separately from model reasoning and
      // transport faults. The callback must yield inert bounded JSON text.
      try {
        const payload = parseBoundedJson(output, 4096, 'model decision receipt');
        if (!own(payload, ['decision', 'costMicros']) ||
            Object.keys(payload).length !== 2 || !Number.isSafeInteger(payload.costMicros) ||
            payload.costMicros < 0) invalid('model cost/decision receipt invalid');
        costMicros = payload.costMicros;
        modelAnswer = decision(payload.decision);
        failureStage = item.accepted.has(modelAnswer) ? 'none' : 'model';
      } catch {
        failureStage = 'schema';
      }
    } catch {
      failureStage = expired ? 'timing' : 'unattributed';
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
    const verifiedSuccess = failureStage === 'none';
    const receipt = {
      id: 'lane_a_' + sha256(JSON.stringify([item.scenarioId, item.scenarioVersion, item.seed])).slice(0, 32),
      lane: 'A', arm: 'model_only', sourceCommit, scenarioId: item.scenarioId,
      scenarioVersion: item.scenarioVersion, seed: item.seed, model, provider: 'none',
      runnerDigest, modelConfigDigest, environmentDigest: item.environmentDigest,
      independentOracleDigest: item.oracleDigest,
      resultEvidenceDigest: sha256(stable({ modelAnswer, failureStage, verifiedSuccess })),
      claimedSuccess: modelAnswer ? JSON.parse(modelAnswer).operation === 'done' : false,
      verifiedSuccess, failureStage,
      latencyMs: Number((performance.now() - started).toFixed(3)),
      costMicros, humanInterventions: 0, unauthorizedEffects: 0
    };
    records.push(receipt);
  }
  const report = buildWave0EvaluationReport({ sourceCommit, records });
  if (report.lanes.A.status !== 'PARTIAL' || report.lanes.B.status !== 'NOT_RUN' ||
      report.lanes.C.status !== 'NOT_RUN' || report.releaseAcceptance !== 'NOT_ACCEPTED') {
    invalid('model-only harness cannot claim release acceptance or another lane');
  }
  return { records, report, limitation:
    'Synthetic caller-supplied model adapter and scorer evidence only. No authenticated inference, physical action, provider dispatch, or release acceptance.' };
}
