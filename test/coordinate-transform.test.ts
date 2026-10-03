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
