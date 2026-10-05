import type { BeliefObservation, BeliefResolution, EpistemicStatus, EvidenceRef } from './contracts.ts';

const SECRET_KEY = /(pass(word)?|secret|token|authorization|cookie|credential|private.?key|api.?key)/i;

interface StoredObservation extends BeliefObservation {
  insertedAt: string;
}

export class EpistemicStateEngine {
  #claims = new Map<string, StoredObservation[]>();
  #unobservable = new Set<string>();
  #clock: () => Date;
  #maxClaimsPerFact: number;

  constructor(options: { clock?: () => Date; maxClaimsPerFact?: number } = {}) {
    this.#clock = options.clock ?? (() => new Date());
    this.#maxClaimsPerFact = boundedInteger(options.maxClaimsPerFact ?? 32, 1, 256, 'maxClaimsPerFact');
  }

  observe(input: BeliefObservation): BeliefResolution {
    const observation = normalizeObservation(input, this.#clock());
    if (SECRET_KEY.test(observation.factKey)) throw new Error('Secret-bearing epistemic fact keys are rejected.');
    const existing = this.#claims.get(observation.factKey) ?? [];
    const duplicate = existing.find((item) =>
      item.valueDigest === observation.valueDigest
      && item.polarity === observation.polarity
      && item.evidence.digest === observation.evidence.digest
    );
    if (!duplicate) {
      existing.push(observation);
      existing.sort((a, b) => b.evidence.observedAt.localeCompare(a.evidence.observedAt));
      if (existing.length > this.#maxClaimsPerFact) existing.length = this.#maxClaimsPerFact;
      this.#claims.set(observation.factKey, existing);
    }
    this.#unobservable.delete(observation.factKey);
    return this.resolve(observation.factKey);
  }

  markUnobservable(factKeyInput: string): BeliefResolution {
    const factKey = boundedKey(factKeyInput, 'factKey');
    this.#unobservable.add(factKey);
    return this.resolve(factKey);
  }

  clearUnobservable(factKeyInput: string): void {
    this.#unobservable.delete(boundedKey(factKeyInput, 'factKey'));
  }

  resolve(factKeyInput: string): BeliefResolution {
    const factKey = boundedKey(factKeyInput, 'factKey');
    const now = this.#clock();
    const claims = this.#claims.get(factKey) ?? [];
    const live = claims.filter((item) => !item.expiresAt || Date.parse(item.expiresAt) > now.getTime());
    const stale = claims.filter((item) => item.expiresAt && Date.parse(item.expiresAt) <= now.getTime());

    if (live.length === 0) {
      const status: EpistemicStatus = this.#unobservable.has(factKey)
        ? 'UNOBSERVABLE'
        : stale.length > 0 ? 'STALE' : 'UNKNOWN';
      return {
        factKey,
        status,
        confidence: 0,
        supportingEvidence: [],
        contradictingEvidence: [],
        staleEvidence: uniqueEvidence(stale.map((item) => item.evidence)),
        alternatives: [],
        updatedAt: now.toISOString()
      };
    }

    const supports = live.filter((item) => item.polarity === 'supports');
    const contradicts = live.filter((item) => item.polarity === 'contradicts');
    const grouped = new Map<string, number[]>();
    for (const item of supports) {
      const freshness = freshnessWeight(item.evidence.observedAt, now.getTime());
      const values = grouped.get(item.valueDigest) ?? [];
      values.push(item.confidence * freshness);
      grouped.set(item.valueDigest, values);
    }
    const alternatives = [...grouped.entries()]
      .map(([valueDigest, values]) => ({ valueDigest, confidence: combineConfidence(values) }))
      .sort((a, b) => b.confidence - a.confidence || a.valueDigest.localeCompare(b.valueDigest));

    const top = alternatives[0];
    const second = alternatives[1];
    const contradiction = combineConfidence(contradicts.map((item) =>
      item.confidence * freshnessWeight(item.evidence.observedAt, now.getTime())
    ));
    const support = top?.confidence ?? 0;

    let status: EpistemicStatus;
    if (!top && contradiction >= 0.7) status = 'DISPROVEN';
    else if (!top) status = 'UNKNOWN';
    else if (second && second.confidence >= 0.45 && Math.abs(top.confidence - second.confidence) < 0.2) status = 'CONFLICTED';
    else if (contradiction >= 0.55 && support >= 0.55) status = 'CONFLICTED';
    else if (support >= 0.85 && contradiction < 0.35) status = 'KNOWN';
    else if (support >= 0.55) status = 'SUPPORTED';
    else status = 'UNKNOWN';

    return {
      factKey,
      status,
      confidence: status === 'DISPROVEN' ? contradiction : support,
      ...(top ? { selectedValueDigest: top.valueDigest } : {}),
      supportingEvidence: uniqueEvidence(
        supports.filter((item) => !top || item.valueDigest === top.valueDigest).map((item) => item.evidence)
      ),
      contradictingEvidence: uniqueEvidence(contradicts.map((item) => item.evidence)),
      staleEvidence: uniqueEvidence(stale.map((item) => item.evidence)),
      alternatives,
      updatedAt: now.toISOString()
    };
  }

  snapshot(factKeys?: string[]): BeliefResolution[] {
    const keys = factKeys
      ? [...new Set(factKeys.map((item) => boundedKey(item, 'factKey')))]
      : [...new Set([...this.#claims.keys(), ...this.#unobservable])];
    return keys.sort().map((key) => this.resolve(key));
  }
}

function normalizeObservation(input: BeliefObservation, now: Date): StoredObservation {
  if (!input || typeof input !== 'object') throw new Error('Belief observation is required.');
  const factKey = boundedKey(input.factKey, 'factKey');
  const valueDigest = sha256(input.valueDigest, 'valueDigest');
  const confidence = unit(input.confidence, 'confidence');
  if (input.polarity !== 'supports' && input.polarity !== 'contradicts') throw new Error('polarity is invalid.');
  const evidence = normalizeEvidence(input.evidence);
  if (input.expiresAt !== undefined && Date.parse(input.expiresAt) <= Date.parse(evidence.observedAt)) {
    throw new Error('expiresAt must follow evidence.observedAt.');
  }
  return {
    factKey,
    valueDigest,
    polarity: input.polarity,
    confidence,
    evidence,
    ...(input.expiresAt ? { expiresAt: validIso(input.expiresAt, 'expiresAt') } : {}),
    ...(input.summary ? { summary: boundedText(input.summary, 1024, 'summary') } : {}),
    insertedAt: now.toISOString()
  };
}

function normalizeEvidence(input: EvidenceRef): EvidenceRef {
  if (!input || typeof input !== 'object') throw new Error('evidence is required.');
  return {
    digest: sha256(input.digest, 'evidence.digest'),
    source: boundedText(input.source, 256, 'evidence.source'),
    observedAt: validIso(input.observedAt, 'evidence.observedAt'),
    ...(input.channel ? { channel: boundedText(input.channel, 128, 'evidence.channel') } : {}),
    ...(input.scope ? { scope: boundedText(input.scope, 512, 'evidence.scope') } : {})
  };
}

function freshnessWeight(observedAt: string, now: number): number {
  const age = Math.max(0, now - Date.parse(observedAt));
  const halfLife = 5 * 60_000;
  return Math.max(0.2, Math.pow(0.5, age / halfLife));
}

function combineConfidence(values: number[]): number {
  return clamp01(1 - values.reduce((remaining, value) => remaining * (1 - clamp01(value)), 1));
}

function uniqueEvidence(items: EvidenceRef[]): EvidenceRef[] {
  return [...new Map(items.map((item) => [item.digest, item])).values()]
    .sort((a, b) => b.observedAt.localeCompare(a.observedAt));
}

function boundedKey(input: unknown, label: string): string {
  const value = String(input ?? '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,511}$/.test(value)) throw new Error(label + ' is invalid.');
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
function boundedText(input: unknown, max: number, label: string): string {
  const value = String(input ?? '');
  if (!value || value.length > max) throw new Error(label + ' is invalid.');
  return value;
}
function boundedInteger(input: unknown, min: number, max: number, label: string): number {
  const value = Number(input);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(label + ' is invalid.');
  return value;
}
function unit(input: unknown, label: string): number {
  const value = Number(input);
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(label + ' must be between 0 and 1.');
  return value;
}
function clamp01(value: number): number { return Math.max(0, Math.min(1, value)); }
