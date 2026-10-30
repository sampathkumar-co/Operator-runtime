/** Best-effort release for native held-button drawing, including after cancellation.
 * All points MUST already have been independently validated and hit-tested by
 * browser-cdp-frames.ts before this helper is called.
 */
export type BrowserStrokePoint = { x: number; y: number };
export type MouseDispatch = (params: Record<string, unknown>, cleanup?: boolean) => Promise<unknown>;

export async function dispatchHeldPointerStroke(
  points: readonly BrowserStrokePoint[], dispatch: MouseDispatch
): Promise<void> {
  if (points.length < 2 || points.length > 24 ||
      points.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) {
    throw new Error('INVALID_BROWSER_GESTURE_PATH');
  }
  const first = points[0]!;
  await dispatch({ type:'mouseMoved', x:first.x, y:first.y, button:'none', buttons:0 });
  let last = first;
  // Even an RPC rejection from mousePressed may mean the event was sent.
  // Release without the canceled action signal to avoid stranding the button.
  try {
    await dispatch({ type:'mousePressed', x:first.x, y:first.y, button:'left', buttons:1, clickCount:1 });
    for (const point of points.slice(1)) {
      last = point;
      await dispatch({ type:'mouseMoved', x:point.x, y:point.y, button:'left', buttons:1 });
    }
  } finally {
    await dispatch({ type:'mouseReleased', x:last.x, y:last.y, button:'left', buttons:0, clickCount:1 }, true);
  }
}
