import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

type McpInvocationContext = {
  scope: string;
  requestId: string;
};

const invocationContext = new AsyncLocalStorage<McpInvocationContext>();

export function withMcpInvocation<T>(body: unknown, scopeInput: string, operation: () => T): T {
  const requestId = jsonRpcRequestId(body);
  if (requestId === undefined) return operation();
  const scope = boundedScope(scopeInput);
  return invocationContext.run({ scope, requestId }, operation);
}

export function currentMcpTaskId(): string | undefined {
  const current = invocationContext.getStore();
  if (!current) return undefined;
  const digest = crypto.createHash('sha256')
    .update('operator-mcp-invocation-v1\0', 'utf8')
    .update(current.scope, 'utf8')
    .update('\0', 'utf8')
    .update(current.requestId, 'utf8')
    .digest('hex');
  return `mcp-request-${digest}`;
}

function jsonRpcRequestId(body: unknown): string | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const raw = (body as Record<string, unknown>).id;
  if (typeof raw === 'string') {
    if (!raw || raw.length > 1024 || /[\0\r\n]/.test(raw)) return undefined;
    return `string:${raw}`;
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) return `number:${String(raw)}`;
  return undefined;
}

function boundedScope(input: string): string {
  const scope = String(input ?? '').trim();
  if (!scope || scope.length > 2048 || /[\0\r\n]/.test(scope)) {
    throw new Error('MCP invocation scope is invalid.');
  }
  return scope;
}
