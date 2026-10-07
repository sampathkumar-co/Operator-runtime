import crypto from 'node:crypto';
import { canonicalJson } from './action-identity.ts';
import {
  twinSupportsClaim,
  type CounterfactualTwinManifest,
  type TwinFidelityDimension
} from './counterfactual-twin.ts';
import { OperatorError } from './errors.ts';

export interface CounterfactualAlternative {
  id: string;
  planDigest: string;
  predictedEffectDigest: string;
  requiredDimensions: TwinFidelityDimension['dimension'][];
  inputArtifactIds: string[];
}

export interface TwinIsolationReport {
  workspaceDisposable: boolean;
  hostWrites: boolean;
  networkMode: 'none' | 'restricted';
}

export interface TwinAdapterResult {
  exitCode: number;
  observedEffectDigest: string;
  evidenceArtifactIds: string[];
  verifiedPostconditions: number;
  riskScore: number;
  durationMs: number;
  hostMutation: boolean;
  isolation: TwinIsolationReport;
}

export interface TwinExecutionAdapter {
  readonly name: string;
  execute(manifest: CounterfactualTwinManifest, alternative: CounterfactualAlternative, signal?: AbortSignal): Promise<TwinAdapterResult>;
}

export interface CounterfactualTwinReceipt {
  schemaVersion: 1;
  id: string;
  twinId: string;
  alternativeId: string;
  adapter: string;
  status: 'PASSED' | 'FAILED' | 'UNSUPPORTED';
  reason?: string;
  planDigest: string;
  predictedEffectDigest: string;
  observedEffectDigest?: string;
  evidenceArtifactIds: string[];
  verifiedPostconditions: number;
  riskScore: number;
  durationMs: number;
  executedAt: string;
}

export interface CounterfactualSelection {
  selectedAlternativeId?: string;
  receiptId?: string;
  reason: string;
}

export async function executeCounterfactualTwinAlternatives(input: {
  manifest: CounterfactualTwinManifest;
  alternatives: CounterfactualAlternative[];
  adapter: TwinExecutionAdapter;
  signal?: AbortSignal;
  clock?: () => Date;
}): Promise<CounterfactualTwinReceipt[]> {
  if (!input.manifest || input.manifest.schemaVersion !== 1) throw invalid('Twin manifest is invalid.');
  if (!Array.isArray(input.alternatives) || input.alternatives.length < 1 || input.alternatives.length > 32) {
    throw invalid('Counterfactual alternatives must contain 1-32 entries.');
  }
  if (!input.adapter || !/^[A-Za-z0-9._:@/+-=]{1,256}$/.test(input.adapter.name)) throw invalid('Twin execution adapter is invalid.');
  const seen = new Set<string>();
  const alternatives = input.alternatives.map((item) => normalizeAlternative(item));
  for (const alternative of alternatives) {
    if (seen.has(alternative.id)) throw invalid('Counterfactual alternative ids must be unique.');
    seen.add(alternative.id);
  }

  const receipts: CounterfactualTwinReceipt[] = [];
  const clock = input.clock ?? (() => new Date());
  for (const alternative of alternatives) {
    if (input.signal?.aborted) throw new OperatorError('EXECUTION_ABORTED', 'Counterfactual twin execution was cancelled.');
    const support = twinSupportsClaim(input.manifest, alternative.requiredDimensions);
    if (!support.supported) {
      receipts.push(sealReceipt({
        twinId: input.manifest.id,
        alternativeId: alternative.id,
        adapter: input.adapter.name,
        status: 'UNSUPPORTED',
        reason: 'Twin fidelity does not fully model required dimensions: ' + [...support.missing, ...support.partial].join(','),
        planDigest: alternative.planDigest,
        predictedEffectDigest: alternative.predictedEffectDigest,
        evidenceArtifactIds: [],
        verifiedPostconditions: 0,
        riskScore: 1,
        durationMs: 0,
        executedAt: clock().toISOString()
      }));
      continue;
    }

    let result: TwinAdapterResult;
    try {
      result = normalizeAdapterResult(await input.adapter.execute(input.manifest, alternative, input.signal));
    } catch (error) {
      receipts.push(sealReceipt({
        twinId: input.manifest.id,
        alternativeId: alternative.id,
        adapter: input.adapter.name,
        status: 'FAILED',
        reason: error instanceof Error ? boundedText(error.message, 2048, 'adapter error') : 'Twin adapter failed.',
        planDigest: alternative.planDigest,
        predictedEffectDigest: alternative.predictedEffectDigest,
        evidenceArtifactIds: [],
        verifiedPostconditions: 0,
        riskScore: 1,
        durationMs: 0,
        executedAt: clock().toISOString()
      }));
      continue;
    }

    if (result.hostMutation || result.isolation.hostWrites || !result.isolation.workspaceDisposable) {
      throw new OperatorError('COUNTERFACTUAL_TWIN_ISOLATION_BREACH', 'Counterfactual execution reported host mutation or non-disposable workspace.');
    }

    receipts.push(sealReceipt({
      twinId: input.manifest.id,
      alternativeId: alternative.id,
      adapter: input.adapter.name,
      status: result.exitCode === 0 ? 'PASSED' : 'FAILED',
      ...(result.exitCode === 0 ? {} : { reason: 'Twin execution returned non-zero exit status.' }),
      planDigest: alternative.planDigest,
      predictedEffectDigest: alternative.predictedEffectDigest,
      observedEffectDigest: result.observedEffectDigest,
      evidenceArtifactIds: result.evidenceArtifactIds,
      verifiedPostconditions: result.verifiedPostconditions,
      riskScore: result.riskScore,
      durationMs: result.durationMs,
      executedAt: clock().toISOString()
    }));
  }
  return receipts;
}

export function selectCounterfactualAlternative(receiptsInput: CounterfactualTwinReceipt[]): CounterfactualSelection {
  if (!Array.isArray(receiptsInput) || receiptsInput.length < 1 || receiptsInput.length > 32) throw invalid('Twin receipts are invalid.');
  const receipts = receiptsInput.map(validateReceipt);
  const passed = receipts.filter((item) => item.status === 'PASSED');
  if (passed.length === 0) return { reason: 'No fully modeled counterfactual alternative passed verification.' };
  passed.sort((a, b) =>
    b.verifiedPostconditions - a.verifiedPostconditions ||
    a.riskScore - b.riskScore ||
    a.durationMs - b.durationMs ||
    a.alternativeId.localeCompare(b.alternativeId)
  );
  const selected = passed[0]!;
  return {
    selectedAlternativeId: selected.alternativeId,
    receiptId: selected.id,
    reason: 'Selected the verified alternative with the strongest postconditions, then lowest modeled risk and latency.'
  };
}

export function validateCounterfactualTwinReceipt(input: CounterfactualTwinReceipt): CounterfactualTwinReceipt {
  return validateReceipt(input);
}

function normalizeAlternative(input: CounterfactualAlternative): CounterfactualAlternative {
  if (!input || typeof input !== 'object') throw invalid('Counterfactual alternative is invalid.');
  if (!Array.isArray(input.requiredDimensions) || input.requiredDimensions.length < 1 || input.requiredDimensions.length > 8) {
    throw invalid('Counterfactual requiredDimensions are invalid.');
  }
  const dimensions = [...new Set(input.requiredDimensions)];
  const allowed = new Set(['repository','dependencies','environment','services','database','browser','policy','world-state']);
  if (dimensions.some((item) => !allowed.has(item))) throw invalid('Counterfactual requiredDimensions contain an unknown dimension.');
  return {
    id: id(input.id, 'alternative.id'),
    planDigest: digest(input.planDigest, 'planDigest'),
    predictedEffectDigest: digest(input.predictedEffectDigest, 'predictedEffectDigest'),
    requiredDimensions: dimensions.sort() as TwinFidelityDimension['dimension'][],
    inputArtifactIds: uniqueDigests(input.inputArtifactIds, 'inputArtifactIds')
  };
}

function normalizeAdapterResult(input: TwinAdapterResult): TwinAdapterResult {
  if (!input || typeof input !== 'object') throw invalid('Twin adapter result is invalid.');
  if (!Number.isSafeInteger(input.exitCode) || input.exitCode < -1 || input.exitCode > 255) throw invalid('Twin adapter exitCode is invalid.');
  if (typeof input.hostMutation !== 'boolean' || !input.isolation || typeof input.isolation.workspaceDisposable !== 'boolean' || typeof input.isolation.hostWrites !== 'boolean') {
    throw invalid('Twin adapter isolation report is invalid.');
  }
  if (!['none','restricted'].includes(input.isolation.networkMode)) throw invalid('Twin adapter network mode is invalid.');
  return {
    exitCode: input.exitCode,
    observedEffectDigest: digest(input.observedEffectDigest, 'observedEffectDigest'),
    evidenceArtifactIds: uniqueDigests(input.evidenceArtifactIds, 'evidenceArtifactIds'),
    verifiedPostconditions: integer(input.verifiedPostconditions, 0, 100_000, 'verifiedPostconditions'),
    riskScore: finite(input.riskScore, 0, 1, 'riskScore'),
    durationMs: finite(input.durationMs, 0, 24 * 60 * 60_000, 'durationMs'),
    hostMutation: input.hostMutation,
    isolation: {
      workspaceDisposable: input.isolation.workspaceDisposable,
      hostWrites: input.isolation.hostWrites,
      networkMode: input.isolation.networkMode
    }
  };
}

function sealReceipt(input: Omit<CounterfactualTwinReceipt, 'schemaVersion' | 'id'>): CounterfactualTwinReceipt {
  const body = normalizeReceiptBody(input);
  return { schemaVersion: 1, id: sha256(canonicalJson({ schemaVersion: 1, ...body })), ...body };
}

function validateReceipt(input: CounterfactualTwinReceipt): CounterfactualTwinReceipt {
  if (!input || input.schemaVersion !== 1) throw invalid('Twin receipt shape is invalid.');
  const body = normalizeReceiptBody(input);
  const expected = sha256(canonicalJson({ schemaVersion: 1, ...body }));
  if (digest(input.id, 'receipt.id') !== expected) throw invalid('Twin receipt id does not match its content.');
  return { schemaVersion: 1, id: expected, ...body };
}

function normalizeReceiptBody(input: Omit<CounterfactualTwinReceipt, 'schemaVersion' | 'id'>) {
  if (!['PASSED','FAILED','UNSUPPORTED'].includes(input.status)) throw invalid('Twin receipt status is invalid.');
  const reason = input.reason === undefined ? undefined : boundedText(input.reason, 4096, 'reason');
  if (input.status !== 'PASSED' && !reason) throw invalid('Failed or unsupported twin receipt requires a reason.');
  return {
    twinId: digest(input.twinId, 'twinId'),
    alternativeId: id(input.alternativeId, 'alternativeId'),
    adapter: id(input.adapter, 'adapter'),
    status: input.status,
    ...(reason ? { reason } : {}),
    planDigest: digest(input.planDigest, 'planDigest'),
    predictedEffectDigest: digest(input.predictedEffectDigest, 'predictedEffectDigest'),
    ...(input.observedEffectDigest ? { observedEffectDigest: digest(input.observedEffectDigest, 'observedEffectDigest') } : {}),
    evidenceArtifactIds: uniqueDigests(input.evidenceArtifactIds, 'evidenceArtifactIds'),
    verifiedPostconditions: integer(input.verifiedPostconditions, 0, 100_000, 'verifiedPostconditions'),
    riskScore: finite(input.riskScore, 0, 1, 'riskScore'),
    durationMs: finite(input.durationMs, 0, 24 * 60 * 60_000, 'durationMs'),
    executedAt: iso(input.executedAt, 'executedAt')
  };
}

function id(input: unknown, label: string): string {
  const value = String(input ?? '');
  if (!/^[A-Za-z0-9._:@/+-=]{1,256}$/.test(value)) throw invalid(label + ' is invalid.');
  return value;
}
function digest(input: unknown, label: string): string {
  const value = String(input ?? '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(value)) throw invalid(label + ' must be SHA-256.');
  return value;
}
function uniqueDigests(input: unknown, label: string): string[] {
  if (!Array.isArray(input) || input.length > 10_000) throw invalid(label + ' is invalid.');
  return [...new Set(input.map((item) => digest(item, label)))].sort();
}
function boundedText(input: unknown, maxBytes: number, label: string): string {
  if (typeof input !== 'string' || !input.trim() || input.includes('\0') || Buffer.byteLength(input, 'utf8') > maxBytes) throw invalid(label + ' is invalid.');
  return input.trim();
}
function integer(input: unknown, min: number, max: number, label: string): number {
  const value = Number(input);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw invalid(label + ' is invalid.');
  return value;
}
function finite(input: unknown, min: number, max: number, label: string): number {
  const value = Number(input);
  if (!Number.isFinite(value) || value < min || value > max) throw invalid(label + ' is invalid.');
  return value;
}
function iso(input: unknown, label: string): string {
  const value = String(input ?? '');
  if (!value || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw invalid(label + ' must be canonical ISO.');
  return value;
}
function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}
function invalid(message: string): OperatorError {
  return new OperatorError('COUNTERFACTUAL_TWIN_EXECUTION_INVALID', message);
}
