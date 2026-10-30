/** Strict graphical gesture input contract. Model outputs cannot be treated as
 * physical coordinates: path points are only fractions of ONE freshly
 * observed semantic target. The CDP execution layer revalidates each point.
 */
export type ObservedGesturePoint = { xRatio: number; yRatio: number };

export function normalizeObservedGesturePath(raw: unknown): ObservedGesturePoint[] {
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > 24) {
    throw new Error('INVALID_BROWSER_GESTURE_PATH');
  }
  const points: ObservedGesturePoint[] = [];
  for (const point of raw) {
    if (point === null || typeof point !== 'object' || Array.isArray(point) ||
        Object.keys(point).length !== 2 || !Object.hasOwn(point, 'xRatio') || !Object.hasOwn(point, 'yRatio')) {
      throw new Error('INVALID_BROWSER_GESTURE_PATH');
    }
    const { xRatio, yRatio } = point as Record<string, unknown>;
    if (typeof xRatio !== 'number' || typeof yRatio !== 'number' ||
        !Number.isFinite(xRatio) || !Number.isFinite(yRatio) ||
        xRatio < 0.01 || yRatio < 0.01 || xRatio > 0.99 || yRatio > 0.99 ||
        Math.abs(xRatio * 100 - Math.round(xRatio * 100)) > 1e-8 ||
        Math.abs(yRatio * 100 - Math.round(yRatio * 100)) > 1e-8) {
      throw new Error('INVALID_BROWSER_GESTURE_PATH');
    }
    points.push({xRatio,yRatio});
  }
  if (points.every((point) => point.xRatio === points[0]!.xRatio && point.yRatio === points[0]!.yRatio)) {
    throw new Error('INVALID_BROWSER_GESTURE_PATH');
  }
  return points;
}
