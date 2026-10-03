import crypto from 'node:crypto';
import { canonicalJson } from './action-identity.ts';
import type { CoordinateBounds, CoordinateTransform } from './coordinate-transform.ts';
import { normalizeCoordinateTransform } from './coordinate-transform.ts';
import { OperatorError } from './errors.ts';

export type RenderedEvidenceTier = 'target-roi' | 'changed-region' | 'full-capture';

export interface RenderedEvidence {
  version: 3;
  tier: RenderedEvidenceTier;
  sceneKey: string;
  captureId: string;
  captureGeneration: string;
  observedAt: string;
  expiresAt: string;
  region: CoordinateBounds;
  sourceDimensions: { width: number; height: number };
  returnedDimensions: { width: number; height: number };
  transform: CoordinateTransform;
  targetAssociation?: string;
  evidenceDigest: string;
}

export interface RenderedDeltaEvidence {
  version: 3;
  sceneKey: string;
  beforeGeneration: string;
  afterGeneration: string;
  changed: boolean;
  scope: 'target-local' | 'capture';
  region: CoordinateBounds;
  evidenceDigest: string;
}

export function createRenderedEvidence(input: Omit<RenderedEvidence, 'version' | 'evidenceDigest'>): RenderedEvidence {
  const tier = normalizeTier(input.tier);
  const captureGeneration = sha(input.captureGeneration, 'captureGeneration');
  const observedAt = iso(input.observedAt, 'observedAt');
  const expiresAt = iso(input.expiresAt, 'expiresAt');
  if (Date.parse(expiresAt) <= Date.parse(observedAt)) {
    throw new OperatorError('RENDERED_EVIDENCE_INVALID', 'Rendered evidence expiry must follow observation time.');
  }
  const normalized: Omit<RenderedEvidence, 'evidenceDigest'> = {
    version: 3,
    tier,
    sceneKey: text(input.sceneKey, 1024, 'sceneKey'),
    captureId: text(input.captureId, 128, 'captureId'),
    captureGeneration,
    observedAt,
    expiresAt,
    region: bounds(input.region, 'region'),
    sourceDimensions: dimensions(input.sourceDimensions, 'sourceDimensions'),
    returnedDimensions: dimensions(input.returnedDimensions, 'returnedDimensions'),
    transform: normalizeCoordinateTransform(input.transform),
    ...(input.targetAssociation === undefined ? {} : { targetAssociation: text(input.targetAssociation, 512, 'targetAssociation') })
  };
  if (normalized.transform.generation !== captureGeneration) {
    throw new OperatorError('RENDERED_EVIDENCE_INVALID', 'Rendered evidence transform generation does not match the capture generation.');
  }
  return {
    ...normalized,
    evidenceDigest: crypto.createHash('sha256').update('operator-rendered-evidence-v3:').update(canonicalJson(normalized)).digest('hex')
  };
}

export function createRenderedDeltaEvidence(before: RenderedEvidence, after: RenderedEvidence): RenderedDeltaEvidence {
  const normalizedBefore = validateRenderedEvidence(before);
  const normalizedAfter = validateRenderedEvidence(after);
  if (normalizedBefore.sceneKey !== normalizedAfter.sceneKey) {
    throw new OperatorError('RENDERED_SCENE_CHANGED', 'Before and after rendered evidence belong to different scenes.');
  }
  if (canonicalJson(normalizedBefore.region) !== canonicalJson(normalizedAfter.region)) {
    throw new OperatorError('RENDERED_REGION_CHANGED', 'Before and after rendered evidence cover different regions.');
  }
  const value: Omit<RenderedDeltaEvidence, 'evidenceDigest'> = {
    version: 3,
    sceneKey: normalizedBefore.sceneKey,
    beforeGeneration: normalizedBefore.captureGeneration,
    afterGeneration: normalizedAfter.captureGeneration,
    changed: normalizedBefore.captureGeneration !== normalizedAfter.captureGeneration,
    scope: normalizedBefore.tier === 'full-capture' ? 'capture' : 'target-local',
    region: normalizedBefore.region
  };
  return {
    ...value,
    evidenceDigest: crypto.createHash('sha256').update('operator-rendered-delta-v3:').update(canonicalJson(value)).digest('hex')
  };
}

export function validateRenderedEvidence(input: RenderedEvidence): RenderedEvidence {
  const rebuilt = createRenderedEvidence(input);
  if (rebuilt.evidenceDigest !== sha(input.evidenceDigest, 'evidenceDigest')) {
    throw new OperatorError('RENDERED_EVIDENCE_TAMPERED', 'Rendered evidence metadata digest does not verify.');
  }
  return rebuilt;
}

function normalizeTier(input: unknown): RenderedEvidenceTier {
  if (input === 'target-roi' || input === 'changed-region' || input === 'full-capture') return input;
  throw new OperatorError('RENDERED_EVIDENCE_INVALID', 'Rendered evidence tier is invalid.');
}

function bounds(input: CoordinateBounds, label: string): CoordinateBounds {
  const x = finite(input?.x, `${label}.x`);
  const y = finite(input?.y, `${label}.y`);
  const width = positive(input?.width, `${label}.width`);
  const height = positive(input?.height, `${label}.height`);
  return { x, y, width, height };
}

function dimensions(input: { width: number; height: number }, label: string): { width: number; height: number } {
  return { width: positive(input?.width, `${label}.width`), height: positive(input?.height, `${label}.height`) };
}

function finite(input: unknown, label: string): number {
  const value = Number(input);
  if (!Number.isFinite(value) || Math.abs(value) > 1_000_000_000) throw new OperatorError('RENDERED_EVIDENCE_INVALID', `${label} is invalid.`);
  return value;
}

function positive(input: unknown, label: string): number {
  const value = finite(input, label);
  if (value <= 0) throw new OperatorError('RENDERED_EVIDENCE_INVALID', `${label} must be positive.`);
  return value;
}

function text(input: unknown, max: number, label: string): string {
  if (typeof input !== 'string' || input.length < 1 || input.length > max || input.includes('\0')) {
    throw new OperatorError('RENDERED_EVIDENCE_INVALID', `${label} is invalid.`);
  }
  return input;
}

function sha(input: unknown, label: string): string {
  const value = text(input, 64, label).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(value)) throw new OperatorError('RENDERED_EVIDENCE_INVALID', `${label} must be SHA-256.`);
  return value;
}

function iso(input: unknown, label: string): string {
  const value = text(input, 64, label);
  if (!Number.isFinite(Date.parse(value))) throw new OperatorError('RENDERED_EVIDENCE_INVALID', `${label} must be an ISO timestamp.`);
  return value;
}
