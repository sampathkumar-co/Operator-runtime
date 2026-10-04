import { OperatorError } from './errors.ts';

export type CoordinateSpace =
  | 'native-screen'
  | 'window-client'
  | 'browser-viewport'
  | 'css-pixel'
  | 'capture-image'
  | 'resized-image'
  | 'roi-local';

export interface CoordinateTransform {
  from: CoordinateSpace;
  to: CoordinateSpace;
  originX: number;
  originY: number;
  scaleX: number;
  scaleY: number;
  sourceWidth?: number;
  sourceHeight?: number;
  targetWidth?: number;
  targetHeight?: number;
  generation: string;
  provenance: string;
}

export interface CoordinatePoint { x: number; y: number }
export interface CoordinateBounds extends CoordinatePoint { width: number; height: number }

const SPACES: readonly CoordinateSpace[] = [
  'native-screen', 'window-client', 'browser-viewport', 'css-pixel',
  'capture-image', 'resized-image', 'roi-local'
];

export function normalizeCoordinateTransform(input: CoordinateTransform): CoordinateTransform {
  if (!input || typeof input !== 'object' || !SPACES.includes(input.from) || !SPACES.includes(input.to)) {
    throw new OperatorError('COORDINATE_TRANSFORM_INVALID', 'Coordinate transform spaces are invalid.');
  }
  const originX = finite(input.originX, 'originX');
  const originY = finite(input.originY, 'originY');
  const scaleX = positive(input.scaleX, 'scaleX');
  const scaleY = positive(input.scaleY, 'scaleY');
  return {
    from: input.from,
    to: input.to,
    originX,
    originY,
    scaleX,
    scaleY,
    ...(input.sourceWidth === undefined ? {} : { sourceWidth: positive(input.sourceWidth, 'sourceWidth') }),
    ...(input.sourceHeight === undefined ? {} : { sourceHeight: positive(input.sourceHeight, 'sourceHeight') }),
    ...(input.targetWidth === undefined ? {} : { targetWidth: positive(input.targetWidth, 'targetWidth') }),
    ...(input.targetHeight === undefined ? {} : { targetHeight: positive(input.targetHeight, 'targetHeight') }),
    generation: bounded(input.generation, 256, 'generation'),
    provenance: bounded(input.provenance, 512, 'provenance')
  };
}

export function mapCoordinatePoint(point: CoordinatePoint, transformInput: CoordinateTransform, expectedGeneration?: string): CoordinatePoint {
  const transform = normalizeCoordinateTransform(transformInput);
  assertCoordinateGeneration(transform, expectedGeneration);
  return {
    x: transform.originX + finite(point.x, 'point.x') * transform.scaleX,
    y: transform.originY + finite(point.y, 'point.y') * transform.scaleY
  };
}

export function mapCoordinateBounds(bounds: CoordinateBounds, transformInput: CoordinateTransform, expectedGeneration?: string): CoordinateBounds {
  const transform = normalizeCoordinateTransform(transformInput);
  assertCoordinateGeneration(transform, expectedGeneration);
  const point = mapCoordinatePoint(bounds, transform);
  return {
    ...point,
    width: positive(bounds.width, 'bounds.width') * transform.scaleX,
    height: positive(bounds.height, 'bounds.height') * transform.scaleY
  };
}

export function composeCoordinateTransforms(firstInput: CoordinateTransform, secondInput: CoordinateTransform): CoordinateTransform {
  const first = normalizeCoordinateTransform(firstInput);
  const second = normalizeCoordinateTransform(secondInput);
  if (first.to !== second.from) throw new OperatorError('COORDINATE_TRANSFORM_MISMATCH', 'Coordinate transforms do not share an intermediate space.');
  if (first.generation !== second.generation) throw new OperatorError('COORDINATE_GENERATION_STALE', 'Coordinate transforms belong to different scene generations.');
  return normalizeCoordinateTransform({
    from: first.from,
    to: second.to,
    originX: second.originX + first.originX * second.scaleX,
    originY: second.originY + first.originY * second.scaleY,
    scaleX: first.scaleX * second.scaleX,
    scaleY: first.scaleY * second.scaleY,
    ...(first.sourceWidth === undefined ? {} : { sourceWidth: first.sourceWidth }),
    ...(first.sourceHeight === undefined ? {} : { sourceHeight: first.sourceHeight }),
    ...(second.targetWidth === undefined ? {} : { targetWidth: second.targetWidth }),
    ...(second.targetHeight === undefined ? {} : { targetHeight: second.targetHeight }),
    generation: first.generation,
    provenance: `${first.provenance} -> ${second.provenance}`.slice(0, 512)
  });
}

export function assertCoordinateGeneration(transform: CoordinateTransform, expectedGeneration?: string): void {
  if (expectedGeneration !== undefined && transform.generation !== expectedGeneration) {
    throw new OperatorError('COORDINATE_GENERATION_STALE', 'Coordinates were derived from a stale scene generation.', { retryable: true });
  }
}

function finite(input: unknown, label: string): number {
  const value = Number(input);
  if (!Number.isFinite(value) || Math.abs(value) > 1_000_000_000) throw new OperatorError('COORDINATE_TRANSFORM_INVALID', `${label} is invalid.`);
  return value;
}

function positive(input: unknown, label: string): number {
  const value = finite(input, label);
  if (value <= 0) throw new OperatorError('COORDINATE_TRANSFORM_INVALID', `${label} must be positive.`);
  return value;
}

function bounded(input: unknown, max: number, label: string): string {
  if (typeof input !== 'string' || input.length < 1 || input.length > max || input.includes('\0')) {
    throw new OperatorError('COORDINATE_TRANSFORM_INVALID', `${label} is invalid.`);
  }
  return input;
}
