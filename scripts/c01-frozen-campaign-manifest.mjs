import crypto from 'node:crypto';
import { requireDenseEvaluationArray, requireInertEvaluationObject } from './c01-inert-evaluation-input.mjs';

const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/;
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function invalid(reason) { throw new Error('C01_CAMPAIGN_MANIFEST_INVALID: ' + reason); }
function text(value, max, label) {
  if (typeof value !== 'string' || value.length < 1 || value.length > max ||
      value.includes('\0')) invalid(label + ' is not a bounded literal');
  return value;
}
function number(value, low, high, label) {
  if (!Number.isSafeInteger(value) || value < low || value > high) {
    invalid(label + ' must be an exact bounded integer');
  }
  return value;
}
function hash(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) invalid(label + ' must be a SHA-256');
  return value;
}
function name(value, label) {
  text(value,128,label);
  if (!NAME.test(value)) invalid(label + ' is not a canonical identifier');
  return value;
}

/**
 * A reproducible *source-only* C01 manifest contract. This makes it possible
 * to audit a preregistered 125-task campaign and 3+ seeds, without inventing
 * an executed model, device, scorer, holdout, or released-version benchmark.
 * Task IDs/revisions/hashes MUST be supplied from independent dataset assets.
 */
export function validateFrozen125CampaignManifest(input) {
  requireInertEvaluationObject(input, invalid, 'campaign input',
    ['sourceCommit','dataset','seeds','models','budget','runnerDigest','environmentDigest']);
  if (typeof input.sourceCommit !== 'string' || !COMMIT.test(input.sourceCommit)) {
    invalid('candidate source Git commit must be exact');
  }
  const dataset = requireInertEvaluationObject(input.dataset, invalid, 'dataset',
    ['name','revision','taskIds','fixtureBuildDigest','independentOracleDigest']);
  name(dataset.name,'dataset name');
  if (!COMMIT.test(dataset.revision ?? '')) invalid('dataset revision must be a Git commit');
  hash(dataset.fixtureBuildDigest,'fixture build');
  hash(dataset.independentOracleDigest,'independent scorer definition');
  requireDenseEvaluationArray(dataset.taskIds,125,125,invalid,'all 125 task identities');
  for (const id of dataset.taskIds) name(id,'task identity');
  if (new Set(dataset.taskIds).size !== 125) invalid('duplicate or missing benchmark task identity');

  requireDenseEvaluationArray(input.seeds,3,32,invalid,'frozen seeds');
  input.seeds.forEach(seed=>number(seed,0,1_000_000_000,'seed'));
  if (!input.seeds.includes(0) || !input.seeds.includes(42) ||
      new Set(input.seeds).size !== input.seeds.length) {
    invalid('seeds must be unique and include preregistered 0 and 42');
  }

  requireDenseEvaluationArray(input.models,1,16,invalid,'model profiles');
  for(const model of input.models){
    requireInertEvaluationObject(model,invalid,'model profile',
      ['name','version','configDigest','promptDigest']);
    name(model.name,'model name');
    name(model.version,'model version');
    if (model.name === 'scripted' || model.name === 'none') invalid('synthetic model is not an independent model lane');
    hash(model.configDigest,'model configuration');
    hash(model.promptDigest,'model prompt contract');
  }
  if(new Set(input.models.map(m=>m.name+':'+m.version)).size !== input.models.length){
    invalid('model version profiles are duplicated');
  }

  const budget=requireInertEvaluationObject(input.budget,invalid,'budget',
    ['maxSteps','maxModelCalls','maxTokensPerCall','maxCostMicros','maxWallTimeMs']);
  number(budget.maxSteps,1,1000,'steps');
  number(budget.maxModelCalls,1,1000,'model calls');
  number(budget.maxTokensPerCall,16,65536,'tokens');
  number(budget.maxCostMicros,0,100_000_000,'max cost micros');
  number(budget.maxWallTimeMs,100,3_600_000,'wall time');
  hash(input.runnerDigest,'runner version');
  hash(input.environmentDigest,'environment version');

  // Reconstruct from allowlisted exact fields so unknown input data cannot
  // sneak passwords or raw prompts into the persisted campaign manifest.
  const frozen={
    schemaVersion:1,
    sourceCommit:input.sourceCommit,
    dataset:{name:dataset.name,revision:dataset.revision,
      taskIds:[...dataset.taskIds],fixtureBuildDigest:dataset.fixtureBuildDigest,
      independentOracleDigest:dataset.independentOracleDigest},
    seeds:[...input.seeds],
    models:input.models.map(m=>({
      name:m.name,version:m.version,configDigest:m.configDigest,promptDigest:m.promptDigest
    })),
    budget:{maxSteps:budget.maxSteps,maxModelCalls:budget.maxModelCalls,
      maxTokensPerCall:budget.maxTokensPerCall,maxCostMicros:budget.maxCostMicros,
      maxWallTimeMs:budget.maxWallTimeMs},
    runnerDigest:input.runnerDigest,environmentDigest:input.environmentDigest
  };
  const suiteDigest=digest(frozen);
  return {
    schemaVersion:1,sourceCommit:input.sourceCommit,
    preregistered:{suiteDigest,expectedScenarioIds:[...dataset.taskIds],
      expectedSeeds:[...input.seeds]},
    manifestDigest:suiteDigest,
    taskCount:125,seedCount:input.seeds.length,modelCount:input.models.length,
    sourceContract:'PREREGISTERED_ONLY',
    laneA:'NOT_RUN',laneB:'NOT_RUN',laneC:'NOT_RUN',
    independentScoring:'NOT_AUTHENTICATED',
    deviceAcceptance:'NOT_VERIFIED',
    historicalMiniWob102of125:'UNREPRODUCIBLE_NOT_COUNTED',
    releaseAcceptance:'NOT_ACCEPTED'
  };
}
