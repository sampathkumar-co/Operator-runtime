import path from 'node:path';
import type { ActionRequest, ActionResult, ActionRisk } from '../../../src/core/types.ts';
import { OperatorError } from '../../../src/core/errors.ts';
import { stableActionId } from '../../../src/core/action-identity.ts';
import { LocalAgentClient } from './local-agent-client.ts';
import { assertNoRestrictedData, assertPublicSafePath } from './restricted-data.ts';

const INTERNAL_KEYS = new Set([
  'provider', 'evidence', 'durationMs', 'actionId', 'taskId', 'sessionId',
  'deviceId', 'accountId', 'deliveryId', 'principalHash', 'fingerprint',
  'diagnostics', 'endpoint'
]);
const PATH_KEYS = new Set(['path', 'cwd', 'root', 'projectRoot', 'registryPath']);
const PATH_INPUT_KEYS = new Set(['path', 'cwd', 'leftPath', 'rightPath']);

export async function invokePublicWithAgent(
  agent: LocalAgentClient,
  capability: string,
  risk: ActionRisk,
  input: Record<string, unknown>,
  target?: string,
  auth?: { grantedScopes?: readonly string[]; readScope?: string; writeScope?: string }
) {
  try {
    requirePublicScope(risk, auth);
    validatePublicInput(input);
    const action: ActionRequest = {
      id: stableActionId(capability, risk, input, target),
      capability, risk, input,
      provenance: { kind: 'chatgpt' },
      target
    };
    const result = await agent.execute(action);
    return publicMcpResult(result);
  } catch (error) {
    const op = error instanceof OperatorError
      ? error
      : new OperatorError('PUBLIC_BOUNDARY_REJECTED', error instanceof Error ? error.message : String(error));
    return publicMcpError(capability, op.code, op.message, op.retryable);
  }
}

function requirePublicScope(
  risk: ActionRisk,
  auth: { grantedScopes?: readonly string[]; readScope?: string; writeScope?: string } | undefined
): void {
  if (!auth) return;
  const needed = risk === 'read' ? auth.readScope : auth.writeScope;
  if (!needed) return;
  if (!(auth.grantedScopes ?? []).includes(needed)) {
    throw new OperatorError('OAUTH_SCOPE_REQUIRED', `This public tool requires OAuth scope ${needed}.`);
  }
}

function validatePublicInput(input: Record<string, unknown>): void {
  assertNoRestrictedData(input);
  for (const [key, value] of Object.entries(input)) {
    if (!PATH_INPUT_KEYS.has(key) || typeof value !== 'string') continue;
    assertPublicSafePath(value);
  }
}

function publicMcpResult(result: ActionResult) {
  if (result.output !== undefined) assertNoRestrictedData(result.output);
  const projected = {
    ok: result.ok,
    capability: result.capability,
    ...(result.output === undefined ? {} : { output: sanitizePublicValue(result.output) }),
    ...(result.error ? {
      error: {
        code: result.error.code,
        message: result.error.message,
        retryable: result.error.retryable === true
      }
    } : {})
  };
  const summary = result.ok
    ? `${result.capability}: verified.`
    : `${result.capability}: not completed (${result.error?.code ?? 'UNKNOWN'}).`;
  return {
    isError: !result.ok,
    content: [{ type: 'text' as const, text: summary }],
    structuredContent: projected
  };
}

function publicMcpError(capability: string, code: string, message: string, retryable = false) {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: `${capability}: not completed (${code}).` }],
    structuredContent: { ok: false, capability, error: { code, message, retryable } }
  };
}

function sanitizePublicValue(value: unknown, keyHint = ''): unknown {
  if (Array.isArray(value)) return value.map((item) => sanitizePublicValue(item, keyHint));
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && PATH_KEYS.has(keyHint) && looksAbsolutePath(value)) {
      return publicPathLabel(value);
    }
    return value;
  }
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (INTERNAL_KEYS.has(key) || /(?:created|updated|recorded|acked|approved|consumed|denied|issued|expires|revoked)At$/.test(key)) continue;
    result[key] = sanitizePublicValue(item, key);
  }
  return result;
}

function looksAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('/');
}

function publicPathLabel(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length === 0) return path.basename(value);
  return parts.slice(-2).join('/');
}
