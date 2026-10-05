import type { EvidenceRef } from './contracts.ts';

export interface PerceptionFactClaim {
  factKey: string;
  valueDigest: string;
  channel: 'dom' | 'accessibility' | 'uia' | 'visual' | 'application' | 'runtime' | string;
  confidence: number;
  evidence: EvidenceRef;
  correlationKey?: string;
}

export interface PerceptionConflictValue {
  valueDigest: string;
  confidence: number;
  channels: string[];
  evidence: EvidenceRef[];
}

export interface PerceptionConflict {
  factKey: string;
  severity: number;
  values: PerceptionConflictValue[];
  independentChannels: string[];
  recommendation: string;
}

export function detectPerceptionConflicts(claimsInput: PerceptionFactClaim[]): PerceptionConflict[] {
  if (!Array.isArray(claimsInput) || claimsInput.length > 10_000) throw new Error('perception claims are invalid.');
  const claims = claimsInput.map(normalizeClaim);
  const byFact = new Map<string, PerceptionFactClaim[]>();
  for (const claim of claims) {
    const list = byFact.get(claim.factKey) ?? [];
    list.push(claim);
    byFact.set(claim.factKey, list);
  }

  const conflicts: PerceptionConflict[] = [];
  for (const [factKey, factClaims] of byFact) {
    const independent = deduplicateCorrelated(factClaims);
    const values = new Map<string, PerceptionFactClaim[]>();
    for (const claim of independent) {
      const list = values.get(claim.valueDigest) ?? [];
      list.push(claim);
      values.set(claim.valueDigest, list);
    }
    if (values.size < 2) continue;

    const ranked: PerceptionConflictValue[] = [...values.entries()].map(([valueDigest, items]) => ({
      valueDigest,
      confidence: combine(items.map((item) => item.confidence * channelWeight(item.channel))),
      channels: [...new Set(items.map((item) => item.channel))].sort(),
      evidence: uniqueEvidence(items.map((item) => item.evidence))
    })).sort((a, b) => b.confidence - a.confidence || a.valueDigest.localeCompare(b.valueDigest));

    const strong = ranked.filter((item) => item.confidence >= 0.45);
    if (strong.length < 2) continue;
    const channels = [...new Set(independent.map((item) => item.channel))].sort();
    const severity = clamp01((strong[0]!.confidence + strong[1]!.confidence) / 2 * Math.min(1, channels.length / 2));
    conflicts.push({
      factKey,
      severity: round(severity),
      values: ranked,
      independentChannels: channels,
      recommendation: recommendationFor(channels)
    });
  }

  return conflicts.sort((a, b) => b.severity - a.severity || a.factKey.localeCompare(b.factKey));
}

function deduplicateCorrelated(claims: PerceptionFactClaim[]): PerceptionFactClaim[] {
  const seen = new Map<string, PerceptionFactClaim>();
  for (const claim of claims) {
    const key = claim.evidence.independenceKey
      ?? claim.correlationKey
      ?? claim.channel + ':' + claim.evidence.digest;
    const current = seen.get(key);
    if (!current || claim.confidence > current.confidence) seen.set(key, claim);
  }
  return [...seen.values()];
}

function recommendationFor(channels: string[]): string {
  const semantic = channels.some((channel) => ['dom','accessibility','uia','application','runtime'].includes(channel));
  const visual = channels.includes('visual');
  if (semantic && visual) return 'Acquire a fresh target-local semantic observation plus a targeted visual crop and reconcile geometry/state.';
  if (semantic) return 'Acquire an independent semantic channel or target-local visual observation before mutation.';
  return 'Acquire a structured semantic/accessibility/UIA observation before trusting pixels alone.';
}

function normalizeClaim(input: PerceptionFactClaim): PerceptionFactClaim {
  if (!input || typeof input !== 'object') throw new Error('perception claim is required.');
  const channel = bounded(input.channel, 128, 'channel');
  const evidence = normalizeEvidence(input.evidence);
  if (evidence.channel && evidence.channel !== channel) {
    throw new Error('Perception claim channel must match evidence channel.');
  }
  const correlationKey = input.correlationKey
    ? bounded(input.correlationKey, 512, 'correlationKey')
    : undefined;
  if (correlationKey && evidence.independenceKey && correlationKey !== evidence.independenceKey) {
    throw new Error('Perception correlationKey conflicts with evidence independenceKey.');
  }
  return {
    factKey: bounded(input.factKey, 512, 'factKey'),
    valueDigest: sha256(input.valueDigest, 'valueDigest'),
    channel,
    confidence: unit(input.confidence, 'confidence'),
    evidence,
    ...(correlationKey ? { correlationKey } : {})
  };
}

function normalizeEvidence(input: EvidenceRef): EvidenceRef {
  if (!input || typeof input !== 'object') throw new Error('perception evidence is required.');
  return {
    digest: sha256(input.digest, 'evidence.digest'),
    source: bounded(input.source, 256, 'evidence.source'),
    observedAt: validIso(input.observedAt, 'evidence.observedAt'),
    ...(input.channel ? { channel: bounded(input.channel, 128, 'evidence.channel') } : {}),
    ...(input.scope ? { scope: bounded(input.scope, 512, 'evidence.scope') } : {}),
    ...(input.independenceKey ? { independenceKey: bounded(input.independenceKey, 512, 'evidence.independenceKey') } : {})
  };
}

function channelWeight(channel: string): number {
  if (channel === 'dom' || channel === 'accessibility' || channel === 'uia') return 1;
  if (channel === 'application' || channel === 'runtime') return 0.95;
  if (channel === 'visual') return 0.8;
  return 0.7;
}
function combine(values: number[]): number {
  return clamp01(1 - values.reduce((remaining, value) => remaining * (1 - clamp01(value)), 1));
}
function uniqueEvidence(items: EvidenceRef[]): EvidenceRef[] {
  const byDigest = new Map<string, EvidenceRef>();
  for (const item of items) {
    const current = byDigest.get(item.digest);
    if (current && JSON.stringify(current) !== JSON.stringify(item)) {
      throw new Error('Conflicting perception evidence metadata for the same digest is rejected.');
    }
    byDigest.set(item.digest, item);
  }
  return [...byDigest.values()].sort((a, b) => b.observedAt.localeCompare(a.observedAt) || a.digest.localeCompare(b.digest));
}
function bounded(input: unknown, max: number, label: string): string {
  const value = String(input ?? '');
  if (!value || value.length > max) throw new Error(label + ' is invalid.');
  return value;
}
function sha256(input: unknown, label: string): string {
  const value = String(input ?? '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(label + ' must be SHA-256.');
  return value;
}
function validIso(input: unknown, label: string): string {
  const value = String(input ?? '');
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new Error(label + ' must be ISO timestamp.');
  return value;
}
function unit(input: unknown, label: string): number {
  const value = Number(input);
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(label + ' must be between 0 and 1.');
  return value;
}
function clamp01(value: number): number { return Math.max(0, Math.min(1, value)); }
function round(value: number): number { return Math.round(value * 1_000_000) / 1_000_000; }
