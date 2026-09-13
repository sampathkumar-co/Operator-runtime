import crypto from 'node:crypto';
import type { ActionRequest } from './types.ts';

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function actionHash(action: ActionRequest): string {
  return crypto.createHash('sha256').update(canonicalJson({
    capability: action.capability,
    risk: action.risk,
    input: action.input,
    provenance: action.provenance,
    target: action.target ?? null
  }), 'utf8').digest('hex');
}

export function stableActionId(
  capability: string,
  risk: ActionRequest['risk'],
  input: Record<string, unknown>,
  target?: string
): string {
  const digest = crypto.createHash('sha256').update(canonicalJson({
    capability,
    risk,
    input,
    provenance: { kind: 'chatgpt' },
    target: target ?? null
  }), 'utf8').digest('hex');
  return `mcp-${digest}`;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(input).sort()) {
    const item = input[key];
    if (item !== undefined) output[key] = canonicalize(item);
  }
  return output;
}
