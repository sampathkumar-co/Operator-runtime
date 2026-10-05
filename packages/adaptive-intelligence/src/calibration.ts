import type { CalibrationSample } from './contracts.ts';

export interface CalibrationBucket {
  lower: number;
  upper: number;
  count: number;
  meanPrediction: number;
  empiricalSuccess: number;
  absoluteGap: number;
}

export interface CalibrationReport {
  samples: number;
  brierScore: number;
  expectedCalibrationError: number;
  meanPrediction: number;
  empiricalSuccess: number;
  buckets: CalibrationBucket[];
}

export class CalibrationTracker {
  #samples: CalibrationSample[] = [];
  #maxSamples: number;

  constructor(options: { maxSamples?: number } = {}) {
    this.#maxSamples = integer(options.maxSamples ?? 50_000, 1, 1_000_000, 'maxSamples');
  }

  static fromSnapshot(samplesInput: CalibrationSample[], options: { maxSamples?: number } = {}): CalibrationTracker {
    if (!Array.isArray(samplesInput) || samplesInput.length > 1_000_000) throw new Error('calibration snapshot is invalid.');
    const tracker = new CalibrationTracker(options);
    if (samplesInput.length > tracker.#maxSamples) throw new Error('Calibration snapshot exceeds configured capacity.');
    for (const sample of samplesInput) tracker.record(sample);
    return tracker;
  }

  record(sample: CalibrationSample): void {
    const normalized: CalibrationSample = {
      prediction: unit(sample.prediction, 'prediction'),
      outcome: sample.outcome === 0 || sample.outcome === 1 ? sample.outcome : (() => { throw new Error('outcome must be 0 or 1.'); })(),
      ...(sample.bucket ? { bucket: bounded(sample.bucket, 256, 'bucket') } : {})
    };
    this.#samples.push(normalized);
    if (this.#samples.length > this.#maxSamples) this.#samples.splice(0, this.#samples.length - this.#maxSamples);
  }

  snapshot(): CalibrationSample[] {
    return structuredClone(this.#samples);
  }

  report(bucketCountInput = 10): CalibrationReport {
    const bucketCount = integer(bucketCountInput, 2, 100, 'bucketCount');
    if (this.#samples.length === 0) {
      return {
        samples: 0,
        brierScore: 0,
        expectedCalibrationError: 0,
        meanPrediction: 0,
        empiricalSuccess: 0,
        buckets: []
      };
    }

    const buckets: CalibrationBucket[] = [];
    let ece = 0;
    for (let index = 0; index < bucketCount; index += 1) {
      const lower = index / bucketCount;
      const upper = (index + 1) / bucketCount;
      const entries = this.#samples.filter((sample) =>
        sample.prediction >= lower && (index === bucketCount - 1 ? sample.prediction <= upper : sample.prediction < upper)
      );
      if (entries.length === 0) continue;
      const meanPrediction = mean(entries.map((item) => item.prediction));
      const empiricalSuccess = mean(entries.map((item) => item.outcome));
      const absoluteGap = Math.abs(meanPrediction - empiricalSuccess);
      ece += absoluteGap * (entries.length / this.#samples.length);
      buckets.push({
        lower: round(lower),
        upper: round(upper),
        count: entries.length,
        meanPrediction: round(meanPrediction),
        empiricalSuccess: round(empiricalSuccess),
        absoluteGap: round(absoluteGap)
      });
    }

    const brier = mean(this.#samples.map((sample) => Math.pow(sample.prediction - sample.outcome, 2)));
    return {
      samples: this.#samples.length,
      brierScore: round(brier),
      expectedCalibrationError: round(ece),
      meanPrediction: round(mean(this.#samples.map((item) => item.prediction))),
      empiricalSuccess: round(mean(this.#samples.map((item) => item.outcome))),
      buckets
    };
  }
}

function mean(values: number[]): number { return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length); }
function unit(input: unknown, label: string): number {
  if (typeof input !== 'number') throw new Error(label + ' must be a number.');
  const value = input;
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(label + ' must be between 0 and 1.');
  return value;
}
function integer(input: unknown, min: number, max: number, label: string): number {
  if (typeof input !== 'number') throw new Error(label + ' must be a number.');
  const value = input;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(label + ' is invalid.');
  return value;
}
function bounded(input: unknown, max: number, label: string): string {
  if (typeof input !== 'string') throw new Error(label + ' must be a string.');
  const value = input;
  if (!value || value.length > max) throw new Error(label + ' is invalid.');
  return value;
}
function round(value: number): number { return Math.round(value * 1_000_000) / 1_000_000; }
