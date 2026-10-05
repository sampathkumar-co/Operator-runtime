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

export function validateCalibrationReport(input:CalibrationReport):CalibrationReport {
  if(!input||typeof input!=='object') throw new Error('calibration report is required.');
  const samples=integer(input.samples,0,100_000_000,'calibration.samples');
  const brierScore=unit(input.brierScore,'calibration.brierScore');
  const expectedCalibrationError=unit(input.expectedCalibrationError,'calibration.expectedCalibrationError');
  const meanPrediction=unit(input.meanPrediction,'calibration.meanPrediction');
  const empiricalSuccess=unit(input.empiricalSuccess,'calibration.empiricalSuccess');
  if(!Array.isArray(input.buckets)||input.buckets.length>100) throw new Error('calibration.buckets is invalid.');

  const buckets=input.buckets.map((bucket,index)=>normalizeBucket(bucket,index));
  if(samples===0){
    if(buckets.length!==0) throw new Error('Zero-sample calibration report cannot contain buckets.');
    if(brierScore!==0||expectedCalibrationError!==0||meanPrediction!==0||empiricalSuccess!==0){
      throw new Error('Zero-sample calibration metrics must all be zero.');
    }
    return {samples,brierScore,expectedCalibrationError,meanPrediction,empiricalSuccess,buckets:[]};
  }
  if(buckets.length===0) throw new Error('Non-empty calibration report requires calibration buckets.');

  let totalCount=0;
  let weightedPrediction=0;
  let weightedSuccess=0;
  let weightedEce=0;
  let priorUpper=-1;
  for(const bucket of buckets){
    if(bucket.lower<priorUpper-1e-9) throw new Error('Calibration bucket intervals must be ordered and non-overlapping.');
    priorUpper=bucket.upper;
    totalCount+=bucket.count;
    weightedPrediction+=bucket.meanPrediction*bucket.count;
    weightedSuccess+=bucket.empiricalSuccess*bucket.count;
    weightedEce+=bucket.absoluteGap*bucket.count;
  }
  if(totalCount!==samples) throw new Error('Calibration bucket counts must equal report sample count.');

  assertApprox(weightedPrediction/samples,meanPrediction,'Calibration weighted meanPrediction mismatch');
  assertApprox(weightedSuccess/samples,empiricalSuccess,'Calibration weighted empiricalSuccess mismatch');
  assertApprox(weightedEce/samples,expectedCalibrationError,'Calibration expectedCalibrationError mismatch');

  return {
    samples,
    brierScore,
    expectedCalibrationError,
    meanPrediction,
    empiricalSuccess,
    buckets
  };
}

function normalizeBucket(input:CalibrationBucket,index:number):CalibrationBucket{
  if(!input||typeof input!=='object') throw new Error('calibration bucket '+index+' is invalid.');
  const lower=unit(input.lower,'calibration.bucket.lower');
  const upper=unit(input.upper,'calibration.bucket.upper');
  if(upper<=lower) throw new Error('Calibration bucket upper bound must exceed lower bound.');
  const count=integer(input.count,1,100_000_000,'calibration.bucket.count');
  const meanPrediction=unit(input.meanPrediction,'calibration.bucket.meanPrediction');
  const empiricalSuccess=unit(input.empiricalSuccess,'calibration.bucket.empiricalSuccess');
  const absoluteGap=unit(input.absoluteGap,'calibration.bucket.absoluteGap');
  if(meanPrediction<lower-1e-6||meanPrediction>upper+1e-6){
    throw new Error('Calibration bucket mean prediction lies outside its interval.');
  }
  assertApprox(Math.abs(meanPrediction-empiricalSuccess),absoluteGap,'Calibration bucket absoluteGap mismatch');
  return {lower,upper,count,meanPrediction,empiricalSuccess,absoluteGap};
}

function assertApprox(actual:number,expected:number,label:string):void{
  if(Math.abs(actual-expected)>5e-6) throw new Error(label+'.');
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
