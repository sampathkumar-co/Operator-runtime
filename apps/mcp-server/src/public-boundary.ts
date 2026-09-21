import path from 'node:path';
import type { ActionRequest, ActionResult, ActionRisk } from '../../../src/core/types.ts';
import { OperatorError } from '../../../src/core/errors.ts';
import { stableActionId } from '../../../src/core/action-identity.ts';
import { LocalAgentClient } from './local-agent-client.ts';
import { assertNoRestrictedData, assertPublicSafePath } from './restricted-data.ts';

const INTERNAL_KEYS = new Set([
  'provider', 'evidence', 'durationMs', 'actionId', 'taskId', 'sessionId',
  'deviceId', 'accountId', 'deliveryId', 'principalHash', 'fingerprint',
  'diagnostics', 'endpoint', 'connectionId', 'requestId', 'traceId', 'jti'
]);
const PATH_INPUT_KEYS = new Set(['path', 'cwd', 'leftPath', 'rightPath']);
const INTERNAL_ID_KEY = /^(?:.*(?:session|device|account|delivery|principal|trace|request|task|action|connection)(?:Id|ID|Hash)|jti|nonce|fingerprint)$/i;
const TEMPORAL_KEY = /(?:created|updated|recorded|acked|approved|consumed|denied|issued|expires|revoked|received|started|finished)At$|^(?:timestamp|time)$/i;

const PUBLIC_ERROR_MESSAGES = new Map<string, string>([
  ['RESTRICTED_DATA_BLOCKED', 'The public plugin refused content that may contain restricted data.'],
  ['RESTRICTED_DATA_PATH_DENIED', 'The public plugin cannot access credential or secret-bearing paths.'],
  ['OAUTH_SCOPE_REQUIRED', 'Additional authorization is required for this action.'],
  ['PATH_OUTSIDE_SCOPE', 'The requested path is outside an authorized project root.'],
  ['PUBLIC_PATH_FILTER_INVALID', 'A requested path filter is not allowed.'],
  ['PRECONDITION_REQUIRED', 'A fresh file precondition is required for this action.'],
  ['PRECONDITION_FAILED', 'The target changed since it was inspected. Inspect it again before retrying.'],
  ['TARGET_EXISTS', 'The target already exists.'],
  ['TARGET_MISSING', 'The target no longer exists.'],
  ['APPROVAL_REQUIRED', 'Local approval is required before this action can run.'],
  ['APPROVAL_EXPIRED', 'The prior local approval expired and must be requested again.'],
  ['ACTION_RISK_MISMATCH', 'The action was rejected because its authorization class was invalid.'],
  ['READ_TOO_LARGE', 'The requested file exceeds the public read limit.'],
  ['WRITE_TOO_LARGE', 'The requested content exceeds the public write limit.'],
  ['NOT_A_FILE', 'The requested target is not a regular file.'],
  ['NOT_A_DIRECTORY', 'The requested target is not a directory.'],
  ['WINDOWS_PATH_LEASE_DENIED', 'Windows path authority validation refused the request.'],
  ['PUBLIC_BOUNDARY_REJECTED', 'The request was rejected by the public safety boundary.']
]);

export async function invokePublicWithAgent(
  agent: LocalAgentClient,
  capability: string,
  risk: ActionRisk,
  input: Record<string, unknown>,
  target?: string,
  auth?: { grantedScopes?: readonly string[]; readScope?: string; writeScope?: string; resourceMetadataUrl?: string }
) {
  const requiredScope = publicRequiredScope(risk, auth);
  try {
    requirePublicScope(requiredScope, auth?.grantedScopes);
    validatePublicInput(input);
    const action: ActionRequest = {
      id: stableActionId(capability, risk, input, target),
      capability, risk, input,
      provenance: { kind: 'chatgpt' },
      target
    };
    const result = await agent.execute(action);
    return publicMcpResult(result, capability);
  } catch (error) {
    const op = error instanceof OperatorError
      ? error
      : new OperatorError('PUBLIC_BOUNDARY_REJECTED', 'The public safety boundary rejected the request.');
    if (op.code === 'OAUTH_SCOPE_REQUIRED' && requiredScope && auth?.resourceMetadataUrl) {
      return publicMcpOAuthChallenge(capability, requiredScope, auth);
    }
    return publicMcpError(capability, op.code, op.retryable);
  }
}

function publicRequiredScope(
  risk: ActionRisk,
  auth: { readScope?: string; writeScope?: string } | undefined
): string | undefined {
  if (!auth) return undefined;
  return risk === 'read' ? auth.readScope : auth.writeScope;
}

function requirePublicScope(needed: string | undefined, grantedScopes: readonly string[] | undefined): void {
  if (!needed) return;
  if (!(grantedScopes ?? []).includes(needed)) {
    throw new OperatorError('OAUTH_SCOPE_REQUIRED', 'Additional authorization is required for this action.');
  }
}

function validatePublicInput(input: Record<string, unknown>): void {
  assertNoRestrictedData(input);
  for (const [key, value] of Object.entries(input)) {
    if (PATH_INPUT_KEYS.has(key) && typeof value === 'string') assertPublicSafePath(value);
    if (key === 'paths' && Array.isArray(value)) {
      for (const item of value) if (typeof item === 'string') assertPublicSafePath(item);
    }
  }
}

function publicMcpResult(result: ActionResult, capability: string) {
  const publicOutput = result.output === undefined ? undefined : minimizePublicOutput(capability, result.output);
  if (publicOutput !== undefined) assertNoRestrictedData(publicOutput);
  const safeError = result.error
    ? publicError(result.error.code, result.error.retryable === true)
    : undefined;
  const projected = {
    ok: result.ok,
    capability,
    ...(publicOutput === undefined ? {} : { output: sanitizePublicValue(publicOutput) }),
    ...(safeError ? { error: safeError } : {})
  };
  const summary = result.ok
    ? `${capability}: verified.`
    : `${capability}: not completed (${safeError?.code ?? 'PUBLIC_REQUEST_FAILED'}).`;
  return {
    isError: !result.ok,
    content: [{ type: 'text' as const, text: summary }],
    structuredContent: projected
  };
}

function minimizePublicOutput(capability: string, output: unknown): unknown {
  if (!isRecord(output)) return output;
  if (capability === 'computer.inspect') return minimizeComputerInspect(output);
  if (capability === 'project.inspect') return minimizeProjectInspect(output);
  if (capability === 'project.command.inspect') return minimizeProjectCommands(output);
  if (capability === 'file.list') return minimizeFileList(output);
  return output;
}

function minimizeComputerInspect(raw: Record<string, unknown>) {
  const platform = String(raw.platform ?? '').toLowerCase();
  const platformFamily = platform === 'win32' ? 'windows'
    : platform === 'darwin' ? 'macos' : platform === 'linux' ? 'linux' : 'other';
  const architecture = /^[A-Za-z0-9_.-]{1,32}$/.test(String(raw.arch ?? '')) ? String(raw.arch) : 'unknown';
  return { platformFamily, architecture };
}

function minimizeProjectInspect(raw: Record<string, unknown>) {
  const scripts = isRecord(raw.scripts) ? Object.keys(raw.scripts).filter(publicSafeName).slice(0, 100).sort() : [];
  return {
    repository: raw.repository === true,
    buildSystems: safeStringArray(raw.buildSystems, 20),
    packageManager: safeOptionalString(raw.packageManager, 64),
    scriptNames: scripts,
    manifests: safeStringArray(raw.manifests, 20).filter(publicSafeName),
    pyprojectDetected: raw.pyprojectDetected === true
  };
}

function minimizeProjectCommands(raw: Record<string, unknown>) {
  const commands = Array.isArray(raw.commands) ? raw.commands : [];
  return {
    registryConfigured: raw.registryConfigured === true,
    commands: commands.slice(0, 100).filter(isRecord).map((command) => ({
      id: safeOptionalString(command.id, 64),
      title: safeOptionalString(command.title, 160),
      kind: safeOptionalString(command.kind, 32),
      risk: safeOptionalString(command.risk, 32),
      expectedOutput: summarizeExpectedOutput(command.artifacts)
    }))
  };
}

function summarizeExpectedOutput(value: unknown) {
  const artifacts = Array.isArray(value) ? value.filter(isRecord).slice(0, 50) : [];
  return {
    artifactCount: artifacts.length,
    kinds: [...new Set(artifacts.map((item) => safeOptionalString(item.kind, 32)).filter(Boolean))].sort(),
    requiresChange: artifacts.some((item) => item.mustChange === true)
  };
}

function minimizeFileList(raw: Record<string, unknown>) {
  const entries = Array.isArray(raw.entries) ? raw.entries : [];
  return {
    entries: entries.filter(isRecord).filter((entry) => publicSafeName(entry.name)).slice(0, 500).map((entry) => ({
      name: String(entry.name),
      type: ['file', 'directory', 'symlink', 'other'].includes(String(entry.type)) ? String(entry.type) : 'other'
    })),
    truncated: raw.truncated === true
  };
}

function publicSafeName(value: unknown): boolean {
  if (typeof value !== 'string' || !value || value.length > 512 || /[\0\r\n]/.test(value)) return false;
  try { assertPublicSafePath(value); return true; } catch { return false; }
}

function safeStringArray(value: unknown, max: number): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string')
    .filter((item) => item.length > 0 && item.length <= 160 && !/[\0\r\n]/.test(item)).slice(0, max) : [];
}
function safeOptionalString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text && text.length <= max && !/[\0\r\n]/.test(text) ? text : undefined;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function publicMcpOAuthChallenge(
  capability: string,
  requiredScope: string,
  auth: { readScope?: string; resourceMetadataUrl?: string }
) {
  const base = publicMcpError(capability, 'OAUTH_SCOPE_REQUIRED');
  const scopes = [...new Set([auth.readScope, requiredScope].filter((scope): scope is string => Boolean(scope)))];
  const challenge = [
    'Bearer',
    `resource_metadata="${challengeValue(auth.resourceMetadataUrl ?? '')}"`,
    'error="insufficient_scope"',
    'error_description="Additional authorization is required for this action."',
    `scope="${challengeValue(scopes.join(' '))}"`
  ].join(' ');
  return { ...base, _meta: { 'mcp/www_authenticate': [challenge] } };
}

function challengeValue(value: string): string {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]/g, '');
}
function publicMcpError(capability: string, code: string, retryable = false) {
  const safeError = publicError(code, retryable);
  return {
    isError: true,
    content: [{ type: 'text' as const, text: `${capability}: not completed (${safeError.code}).` }],
    structuredContent: { ok: false, capability, error: safeError }
  };
}

function publicError(code: string, retryable: boolean) {
  const safeCode = PUBLIC_ERROR_MESSAGES.has(code) ? code : 'PUBLIC_REQUEST_FAILED';
  const message = PUBLIC_ERROR_MESSAGES.get(safeCode)
    ?? 'The request could not be completed safely.';
  return { code: safeCode, message, retryable };
}

function sanitizePublicValue(value: unknown, keyHint = ''): unknown {
  if (Array.isArray(value)) return value.map((item) => sanitizePublicValue(item, keyHint));
  if (!value || typeof value !== 'object') {
    return typeof value === 'string' ? sanitizePublicString(value) : value;
  }
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (shouldOmitPublicKey(key)) continue;
    result[key] = sanitizePublicValue(item, key);
  }
  return result;
}

function shouldOmitPublicKey(key: string): boolean {
  return INTERNAL_KEYS.has(key) || INTERNAL_ID_KEY.test(key) || TEMPORAL_KEY.test(key);
}

function sanitizePublicString(value: string): string {
  if (looksAbsolutePath(value)) return publicPathLabel(value);
  let sanitized = value.replace(
    /\b(?:session|device|account|delivery|principal|trace|request|task|action|connection)[-_ ]?(?:id|hash)\s*[:=]\s*[A-Za-z0-9._:-]+/gi,
    '[internal-id]'
  );
  sanitized = sanitized.replace(/[A-Za-z]:[\\/](?:[^\\/\s"'<>|]+[\\/])*[^\\/\s"'<>|]+/g, '[path]');
  sanitized = sanitized.replace(/\\\\[^\\\s"'<>|]+\\[^\s"'<>|]+/g, '[path]');
  sanitized = sanitized.replace(
    /\/(?:home|Users|root|tmp|var|etc|opt|srv|mnt|Volumes|workspace|workspaces|private|data|app)(?:\/[^\s"'<>]+)+/g,
    '[path]'
  );
  return sanitized;
}

function looksAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value)
    || /^\\\\[^\\]+\\[^\\]+/.test(value)
    || value.startsWith('/');
}

function publicPathLabel(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '');
  const parts = normalized.split('/').filter(Boolean);
  const basename = parts.at(-1) ?? 'item';
  try {
    assertPublicSafePath(basename);
  } catch {
    return '[redacted-path]';
  }
  const safeName = path.basename(basename).slice(0, 160) || 'item';
  return `[path]/${safeName}`;
}
