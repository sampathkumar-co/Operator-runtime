import crypto from 'node:crypto';
import type { ActionRequest, ActionResult } from './types.ts';
import { perceptionDigest, type PerceptionBounds, type PerceptionGraphStore, type PerceptionObservation } from './perception-graph.ts';

const MAX_ELEMENTS = 1500;

export async function publishPerceptionFromActionResult(
  graph: PerceptionGraphStore,
  action: ActionRequest,
  result: ActionResult
): Promise<number> {
  if (!result.ok) return 0;
  if (action.capability === 'app.inspect') return await publishUiaInspection(graph, result);
  if (action.capability === 'visual.capture') return await publishVisualCapture(graph, result);
  return 0;
}

async function publishUiaInspection(graph: PerceptionGraphStore, result: ActionResult): Promise<number> {
  const output = asRecord(result.output);
  const elements = Array.isArray(output.elements) ? output.elements.slice(0, MAX_ELEMENTS) : [];
  let published = 0;
  for (const raw of elements) {
    const element = asRecord(raw);
    const processId = safeInteger(element.process_id, 0, 0xffff_ffff);
    const automationId = safeString(element.automation_id, 512);
    const className = safeString(element.class_name, 512);
    const controlType = safeString(element.control_type, 256);
    const name = safeString(element.name, 1024);
    const depth = safeInteger(element.depth, 0, 1000);
    const bounds = normalizeBounds(element.bounds);
    if (!name && !automationId && !controlType && !bounds) continue;

    const state: Record<string, string | number | boolean | null> = {
      processId,
      depth,
      ...(className ? { className } : {}),
      ...(typeof element.selected === 'boolean' ? { selected: element.selected } : {}),
      ...(safeString(element.expand_collapse_state, 128) ? { expandCollapseState: safeString(element.expand_collapse_state, 128)! } : {})
    };
    const identity = {
      processId,
      automationId,
      className,
      controlType,
      name,
      bounds
    };
    const semanticId = automationId
      ? `uia:${processId}:${crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 32)}`
      : undefined;
    const observation: PerceptionObservation = {
      sceneKey: processId > 0 ? `uia:process:${processId}` : 'uia:desktop',
      channel: 'uia',
      source: result.provider,
      ...(semanticId ? { semanticId } : {}),
      ...(controlType ? { role: controlType } : {}),
      ...(name ? { name } : {}),
      ...(bounds ? { bounds } : {}),
      state,
      confidence: 1,
      ttlMs: 30_000,
      evidenceDigest: perceptionDigest({
        capability: result.capability,
        provider: result.provider,
        identity,
        state
      })
    };
    await graph.observe(observation);
    published += 1;
  }
  return published;
}

async function publishVisualCapture(graph: PerceptionGraphStore, result: ActionResult): Promise<number> {
  const output = asRecord(result.output);
  const captureId = safeString(output.captureId, 128);
  const sha256 = safeString(output.sha256, 64)?.toLowerCase();
  const width = safeInteger(output.width, 0, 1280);
  const height = safeInteger(output.height, 0, 720);
  if (!captureId || !sha256 || !/^[0-9a-f]{64}$/.test(sha256) || width < 1 || height < 1) return 0;
  const source = safeString(output.source, 64) ?? 'unknown';
  const windowId = safeString(output.windowId, 256);
  const state: Record<string, string | number | boolean | null> = {
    captureId,
    sha256,
    source,
    ...(windowId ? { windowId } : {})
  };
  await graph.observe({
    sceneKey: `capture:${captureId}`,
    channel: 'visual',
    source: result.provider,
    semanticId: `capture:${captureId}`,
    role: 'capture',
    name: source,
    bounds: { x: 0, y: 0, width, height },
    state,
    confidence: 1,
    ttlMs: 90_000,
    evidenceDigest: perceptionDigest({
      capability: result.capability,
      provider: result.provider,
      captureId,
      sha256,
      source,
      windowId,
      width,
      height
    })
  });
  return 1;
}

function normalizeBounds(input: unknown): PerceptionBounds | undefined {
  const value = asRecord(input);
  const x = finite(value.x);
  const y = finite(value.y);
  const width = finite(value.width);
  const height = finite(value.height);
  if (x === undefined || y === undefined || width === undefined || height === undefined) return undefined;
  if (width <= 0 || height <= 0 || width > 100_000 || height > 100_000) return undefined;
  return { x, y, width, height };
}

function asRecord(input: unknown): Record<string, any> {
  return input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, any> : {};
}
function safeString(input: unknown, max: number): string | undefined {
  return typeof input === 'string' && input.length > 0 && input.length <= max && !input.includes('\0') ? input : undefined;
}
function safeInteger(input: unknown, min: number, max: number): number {
  const value = Number(input);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : 0;
}
function finite(input: unknown): number | undefined {
  const value = Number(input);
  return Number.isFinite(value) ? value : undefined;
}
