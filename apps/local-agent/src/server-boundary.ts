import crypto from 'node:crypto';
import type http from 'node:http';
import { OperatorError } from '../../../src/core/errors.ts';
import { validIntentBinding } from '../../../src/core/intent-registry.ts';
import type { ActionRequest } from '../../../src/core/types.ts';
import type { EnterpriseAuthorizationContext } from '../../../src/core/enterprise-policy.ts';
import type { ApprovalAuthorityContext } from './approval-store.ts';

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 100_000;
const JSON_UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const ACTION_RISKS = new Set(['read', 'write', 'external', 'system', 'destructive']);
const PROVENANCE_KINDS = new Set(['user', 'chatgpt', 'trusted_policy', 'runtime', 'website', 'file', 'application', 'terminal']);

export function timingSafeTokenMatch(actual: string | undefined, expected: string): boolean {
  if (!actual?.startsWith('Bearer ')) return false;
  return timingSafeSecretMatch(actual.slice('Bearer '.length), expected);
}

export function timingSafeSecretMatch(actual: string | undefined, expected: string): boolean {
  if (typeof actual !== 'string') return false;
  const supplied = Buffer.from(actual);
  const wanted = Buffer.from(expected);
  return supplied.length === wanted.length && crypto.timingSafeEqual(supplied, wanted);
}

export async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_BODY_BYTES) throw new Error('REQUEST_TOO_LARGE');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  let text: string;
  try {
    text = JSON_UTF8_DECODER.decode(Buffer.concat(chunks));
  } catch {
    throw new Error('REQUEST_INVALID_UTF8');
  }
  assertJsonTextDepth(text);
  const parsed = JSON.parse(text) as unknown;
  assertJsonComplexity(parsed);
  return parsed;
}

function assertJsonTextDepth(text: string): void {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{' || char === '[') {
      depth += 1;
      if (depth > MAX_JSON_DEPTH) throw new Error('REQUEST_JSON_TOO_DEEP');
    } else if (char === '}' || char === ']') {
      depth -= 1;
    }
  }
}

function assertJsonComplexity(root: unknown): void {
  const stack: unknown[] = [root];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    nodes += 1;
    if (nodes > MAX_JSON_NODES) throw new Error('REQUEST_JSON_TOO_COMPLEX');
    if (Array.isArray(current)) {
      for (const item of current) stack.push(item);
    } else if (current !== null && typeof current === 'object') {
      for (const item of Object.values(current as Record<string, unknown>)) stack.push(item);
    }
  }
}

export function validateActionEnvelope(value: unknown): ActionRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('action must be a JSON object.');
  const raw = value as Record<string, unknown>;
  const id = boundedString(raw.id, 'action.id', 256);
  const capability = boundedString(raw.capability, 'action.capability', 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(capability)) throw new Error('action.capability contains unsupported characters.');
  if (typeof raw.risk !== 'string' || !ACTION_RISKS.has(raw.risk)) throw new Error('action.risk is invalid.');
  if (!raw.input || typeof raw.input !== 'object' || Array.isArray(raw.input)) throw new Error('action.input must be a JSON object.');
  if (!raw.provenance || typeof raw.provenance !== 'object' || Array.isArray(raw.provenance)) throw new Error('action.provenance must be a JSON object.');
  const provenanceRaw = raw.provenance as Record<string, unknown>;
  if (typeof provenanceRaw.kind !== 'string' || !PROVENANCE_KINDS.has(provenanceRaw.kind)) throw new Error('action.provenance.kind is invalid.');
  const source = provenanceRaw.source === undefined ? undefined : boundedString(provenanceRaw.source, 'action.provenance.source', 512);
  const taskId = raw.taskId === undefined ? undefined : boundedString(raw.taskId, 'action.taskId', 256);
  const target = raw.target === undefined ? undefined : boundedString(raw.target, 'action.target', 4096);
  const intent = raw.intent === undefined ? undefined : validIntentBinding(raw.intent);
  return {
    id,
    capability,
    risk: raw.risk as ActionRequest['risk'],
    input: raw.input as Record<string, unknown>,
    provenance: { kind: provenanceRaw.kind as ActionRequest['provenance']['kind'], source },
    taskId,
    target,
    ...(intent ? { intent } : {})
  };
}

export function validateApprovalAuthority(input: unknown): ApprovalAuthorityContext {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('approvalAuthority must be an object.');
  const raw = input as Record<string, unknown>;
  const accountId = String(raw.accountId ?? '');
  const deviceId = String(raw.deviceId ?? '');
  const generation = Number(raw.generation);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuid.test(accountId) || !uuid.test(deviceId) || !Number.isSafeInteger(generation) || generation < 1) {
    throw new Error('approvalAuthority is invalid.');
  }
  return { accountId: accountId.toLowerCase(), deviceId: deviceId.toLowerCase(), generation };
}

export function relayRequestMarker(input: unknown): boolean {
  if (input === undefined) return false;
  const value = Array.isArray(input) ? (input.length === 1 ? input[0] : undefined) : input;
  if (value !== '1') throw new OperatorError('ENTERPRISE_CONTEXT_INVALID', 'Internal relay request marker is invalid.');
  return true;
}

export function decodeEnterpriseContextHeader(input: unknown, relayRequest: boolean): EnterpriseAuthorizationContext | undefined {
  if (input === undefined) return undefined;
  if (!relayRequest) throw new OperatorError('ENTERPRISE_CONTEXT_INVALID', 'Enterprise context is accepted only on an internal relay request.');
  const encoded = Array.isArray(input) ? (input.length === 1 ? input[0] : undefined) : input;
  if (typeof encoded !== 'string' || encoded.length < 1 || encoded.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new OperatorError('ENTERPRISE_CONTEXT_INVALID', 'Enterprise context header is invalid.');
  }
  let bytes: Buffer;
  try { bytes = Buffer.from(encoded, 'base64url'); }
  catch { throw new OperatorError('ENTERPRISE_CONTEXT_INVALID', 'Enterprise context header is not valid base64url.'); }
  if (bytes.length < 2 || bytes.length > 4096 || bytes.toString('base64url') !== encoded) {
    throw new OperatorError('ENTERPRISE_CONTEXT_INVALID', 'Enterprise context header encoding is non-canonical or oversized.');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString('utf8')); }
  catch { throw new OperatorError('ENTERPRISE_CONTEXT_INVALID', 'Enterprise context header must contain valid JSON.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new OperatorError('ENTERPRISE_CONTEXT_INVALID', 'Enterprise context must be an object.');
  }
  const raw = parsed as Record<string, unknown>;
  const allowedKeys = new Set(['principalId', 'deviceId', 'projectKey']);
  if (Object.keys(raw).some((key) => !allowedKeys.has(key))) {
    throw new OperatorError('ENTERPRISE_CONTEXT_INVALID', 'Enterprise context contains fields not issued by the trusted relay identity path.');
  }
  const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
  const principalId = String(raw.principalId ?? '').toLowerCase();
  const deviceId = String(raw.deviceId ?? '').toLowerCase();
  if (!new RegExp(`^account:${uuid}$`, 'i').test(principalId) || !new RegExp(`^${uuid}$`, 'i').test(deviceId)) {
    throw new OperatorError('ENTERPRISE_CONTEXT_INVALID', 'Enterprise context account/device identity is invalid.');
  }
  const projectKey = raw.projectKey === undefined ? undefined : String(raw.projectKey);
  if (projectKey !== undefined && (!/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,511}$/.test(projectKey) || projectKey.includes('\\'))) {
    throw new OperatorError('ENTERPRISE_CONTEXT_INVALID', 'Enterprise project context is invalid.');
  }
  return { principalId, deviceId, ...(projectKey ? { projectKey } : {}) };
}

export function boundedString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || value.includes('\0')) {
    throw new Error(`${field} must be a non-empty string of at most ${maxLength} characters without NUL bytes.`);
  }
  return value;
}
