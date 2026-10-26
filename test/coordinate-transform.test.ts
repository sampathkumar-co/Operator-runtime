import assert from 'node:assert/strict';
import test from 'node:test';
import { composeCoordinateTransforms, mapCoordinateBounds, mapCoordinatePoint } from '../src/core/coordinate-transform.ts';

test('canonical coordinates compose ROI, resize, and non-zero screen origins', () => {
  const roiToCapture = {
    from: 'roi-local' as const,
    to: 'capture-image' as const,
    originX: 40,
    originY: 20,
    scaleX: 0.5,
    scaleY: 0.5,
    generation: 'capture-7',
    provenance: 'vision-roi'
  };
  const captureToScreen = {
    from: 'capture-image' as const,
    to: 'native-screen' as const,
    originX: -1920,
    originY: 100,
    scaleX: 2,
    scaleY: 2,
    generation: 'capture-7',
    provenance: 'windows-capture'
  };
  const transform = composeCoordinateTransforms(roiToCapture, captureToScreen);
  assert.deepEqual(mapCoordinatePoint({ x: 10, y: 30 }, transform, 'capture-7'), { x: -1830, y: 170 });
  assert.deepEqual(mapCoordinateBounds({ x: 10, y: 30, width: 20, height: 10 }, transform), {
    x: -1830, y: 170, width: 20, height: 10
  });
});

test('canonical coordinates reject stale scene generations', () => {
  assert.throws(
    () => mapCoordinatePoint({ x: 1, y: 1 }, {
      from: 'capture-image', to: 'native-screen', originX: 0, originY: 0,
      scaleX: 1, scaleY: 1, generation: 'new', provenance: 'capture'
    }, 'old'),
    (error: any) => error?.code === 'COORDINATE_GENERATION_STALE'
  );
});

test('C04 rejects coerced, missing and overflowing screen geometry before input dispatch', () => {
  const transform = {
    from: 'capture-image' as const, to: 'native-screen' as const,
    originX: -500, originY: 200, scaleX: 2, scaleY: 2,
    generation: 'fresh-frame', provenance: 'trusted-capture'
  };
  for (const hostile of [
    { x: '10', y: 1 }, { x: true, y: 1 }, { x: null, y: 1 },
    { x: [], y: 1 }, { x: undefined, y: 1 }, null, []
  ]) {
    assert.throws(() => mapCoordinatePoint(hostile as any, transform),
      (error: any) => error?.code === 'COORDINATE_TRANSFORM_INVALID');
  }
  for (const hostile of [
    { ...transform, scaleX: '1' }, { ...transform, originX: false },
    { ...transform, scaleY: null }, { ...transform, originY: [] }
  ]) {
    assert.throws(() => mapCoordinatePoint({ x: 1, y: 1 }, hostile as any),
      (error: any) => error?.code === 'COORDINATE_TRANSFORM_INVALID');
  }
  assert.throws(
    () => mapCoordinatePoint({ x: 900_000_000, y: 1 }, { ...transform, scaleX: 3 }),
    (error: any) => error?.code === 'COORDINATE_TRANSFORM_INVALID'
  );
  assert.throws(
    () => mapCoordinateBounds({ x: 1, y: 1, width: 900_000_000, height: 1 },
      { ...transform, scaleX: 3 }),
    (error: any) => error?.code === 'COORDINATE_TRANSFORM_INVALID'
  );
  assert.deepEqual(mapCoordinatePoint({ x: 10.25, y: 20.5 }, transform, 'fresh-frame'),
    { x: -479.5, y: 241 });
});

test('C04 transformed rectangle must keep its far corners within safe physical coordinates', () => {
  const transform = {
    from: 'capture-image' as const, to: 'native-screen' as const,
    originX: 900_000_000, originY: 900_000_000,
    scaleX: 2, scaleY: 2, generation: 'frame-a', provenance: 'trusted-capture'
  };
  // Every individual coordinate and dimension is finite and within 1e9,
  // but the right or bottom extent can still exceed the permitted bound.
  for (const bounds of [
    { x: 1, y: 1, width: 100_000_000, height: 1 },
    { x: 1, y: 1, width: 1, height: 100_000_000 }
  ]) {
    assert.throws(() => mapCoordinateBounds(bounds, transform, 'frame-a'),
      (error: any) => error?.code === 'COORDINATE_TRANSFORM_INVALID');
  }
  assert.deepEqual(
    mapCoordinateBounds({ x: 2, y: 3, width: 5, height: 7 }, {
      ...transform, originX: -1920, originY: 50
    }, 'frame-a'),
    { x: -1916, y: 56, width: 10, height: 14 }
  );
});

test('C04 composed transform rejects contradictory intermediate capture dimensions', () => {
  const first = {
    from: 'roi-local' as const, to: 'capture-image' as const,
    originX: 10, originY: 20, scaleX: 1, scaleY: 1,
    sourceWidth: 100, sourceHeight: 50,
    targetWidth: 200, targetHeight: 100,
    generation: 'capture-8', provenance: 'source-roi'
  };
  const second = {
    from: 'capture-image' as const, to: 'native-screen' as const,
    originX: -1920, originY: 0, scaleX: 2, scaleY: 2,
    sourceWidth: 200, sourceHeight: 100,
    targetWidth: 400, targetHeight: 200,
    generation: 'capture-8', provenance: 'display'
  };
  const correct = composeCoordinateTransforms(first, second);
  assert.deepEqual(mapCoordinatePoint({ x: 2, y: 3 }, correct, 'capture-8'),
    { x: -1896, y: 46 });
  for (const mismatched of [
    { ...second, sourceWidth: 201 },
    { ...second, sourceHeight: 101 }
  ]) {
    assert.throws(() => composeCoordinateTransforms(first, mismatched),
      (error: any) => error?.code === 'COORDINATE_TRANSFORM_MISMATCH');
  }
  // Dimension declarations may be absent, but when both sides provide
  // a measurement neither can silently override its counterpart.
  assert.doesNotThrow(() => composeCoordinateTransforms(
    { ...first, targetWidth: undefined, targetHeight: undefined },
    second
  ));
});
