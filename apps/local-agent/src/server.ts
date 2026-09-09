import http from 'node:http';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { ActionRequest, PermissionProfile } from '../../../src/core/types.ts';
import type { OperatorRuntime } from '../../../src/core/runtime.ts';
import type { AuditLog } from '../../../src/core/audit.ts';
import type { EmergencyStopStore } from './emergency-stop.ts';

const MAX_BODY_BYTES = 1024 * 1024;

function timingSafeTokenMatch(actual: string | undefined, expected: string): boolean {
  if (!actual?.startsWith('Bearer ')) return false;
  return timingSafeSecretMatch(actual.slice('Bearer '.length), expected);
}

function timingSafeSecretMatch(actual: string | undefined, expected: string): boolean {
  if (typeof actual !== 'string') return false;
  const supplied = Buffer.from(actual);
  const wanted = Buffer.from(expected);
  return supplied.length === wanted.length && crypto.timingSafeEqual(supplied, wanted);
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_BODY_BYTES) throw new Error('REQUEST_TOO_LARGE');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function send(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  res.end(body);
}

export function createLocalAgentServer(options: {
  runtime: OperatorRuntime;
  token: string;
  permissions: PermissionProfile;
  emergencyStop?: EmergencyStopStore;
  recoveryToken?: string;
  onEmergencyStop?: () => Promise<void> | void;
  audit?: AuditLog;
}) {
  if (options.token.length < 32) throw new Error('Agent token must be at least 32 characters.');
  if (options.recoveryToken !== undefined && options.recoveryToken.length < 32) throw new Error('Recovery token must be at least 32 characters.');

  const server = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url ?? '/', 'http://operator.local');
    const pathname = requestUrl.pathname;

    if (pathname === '/health' && req.method === 'GET') {
      const emergencyStopped = options.emergencyStop ? (await options.emergencyStop.status()).engaged : false;
      send(res, 200, { ok: true, service: 'operator-local-agent', version: '0.1.0', emergencyStopped });
      return;
    }

    if (!timingSafeTokenMatch(req.headers.authorization, options.token)) {
      send(res, 401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'Valid agent bearer token required.' } });
      return;
    }

    if (pathname === '/v1/activity' && req.method === 'GET') {
      const requested = Number(requestUrl.searchParams.get('limit') ?? 100);
      const limit = Number.isInteger(requested) ? Math.min(Math.max(requested, 1), 500) : 100;
      send(res, 200, { ok: true, events: options.audit ? await options.audit.tail(limit) : [], configured: Boolean(options.audit) });
      return;
    }

    if (pathname === '/v1/permissions' && req.method === 'GET') {
      send(res, 200, {
        ok: true,
        permissions: {
          allowedCapabilities: [...options.permissions.allowedCapabilities],
          allowedRoots: [...options.permissions.allowedRoots],
          allowExternalWrites: Boolean(options.permissions.allowExternalWrites),
          allowSystemChanges: Boolean(options.permissions.allowSystemChanges),
          allowDestructive: Boolean(options.permissions.allowDestructive),
          approvedActionIds: [...(options.permissions.approvedActionIds ?? [])]
        }
      });
      return;
    }

    if (pathname === '/v1/emergency-stop' && req.method === 'GET') {
      if (!options.emergencyStop) {
        send(res, 200, { ok: true, state: { version: 1, engaged: false }, configured: false });
        return;
      }
      send(res, 200, { ok: true, state: await options.emergencyStop.status(), configured: true });
      return;
    }

    if (pathname === '/v1/emergency-stop' && req.method === 'POST') {
      if (!options.emergencyStop || !options.recoveryToken) {
        send(res, 503, { ok: false, error: { code: 'EMERGENCY_STOP_NOT_CONFIGURED', message: 'Emergency stop requires persistent state and a separate recovery token before it can be engaged.' } });
        return;
      }
      try {
        const body = await readJson(req) as { reason?: unknown };
        const reason = body.reason === undefined ? undefined : String(body.reason);
        const state = await options.emergencyStop.engage(reason);
        await options.onEmergencyStop?.();
        await options.audit?.append({
          capability: 'agent.emergency-stop',
          result: 'success',
          risk: 'destructive',
          details: { operation: 'engage' }
        });
        send(res, 200, { ok: true, state });
      } catch (error) {
        send(res, 400, { ok: false, error: { code: 'BAD_REQUEST', message: error instanceof Error ? error.message : String(error) } });
      }
      return;
    }

    if (pathname === '/v1/emergency-stop' && req.method === 'DELETE') {
      if (!options.emergencyStop || !options.recoveryToken) {
        send(res, 503, { ok: false, error: { code: 'EMERGENCY_STOP_NOT_CONFIGURED', message: 'Emergency stop recovery is not configured.' } });
        return;
      }
      const supplied = Array.isArray(req.headers['x-operator-recovery-token']) ? req.headers['x-operator-recovery-token'][0] : req.headers['x-operator-recovery-token'];
      if (!timingSafeSecretMatch(supplied, options.recoveryToken)) {
        send(res, 401, { ok: false, error: { code: 'RECOVERY_UNAUTHORIZED', message: 'Valid recovery token required.' } });
        return;
      }
      const state = await options.emergencyStop.clear();
      await options.audit?.append({
        capability: 'agent.emergency-stop',
        result: 'success',
        risk: 'destructive',
        details: { operation: 'clear' }
      });
      send(res, 200, { ok: true, state });
      return;
    }

    if (pathname === '/v1/execute' && req.method === 'POST') {
      try {
        if (options.emergencyStop && (await options.emergencyStop.status()).engaged) {
          await options.audit?.append({
            capability: 'agent.execute',
            result: 'blocked',
            risk: 'system',
            details: { code: 'EMERGENCY_STOPPED' }
          });
          send(res, 423, { ok: false, error: { code: 'EMERGENCY_STOPPED', message: 'Operator execution is disabled by the local emergency stop.' } });
          return;
        }
        const body = await readJson(req) as { action?: ActionRequest };
        if (!body.action || typeof body.action !== 'object') {
          send(res, 400, { ok: false, error: { code: 'INVALID_REQUEST', message: 'action is required.' } });
          return;
        }
        const action = body.action;
        const result = await options.runtime.execute(action, options.permissions);
        await options.audit?.append({
          taskId: action.taskId,
          capability: action.capability,
          target: action.target,
          result: result.ok ? 'success' : result.provider === 'policy' ? 'blocked' : 'failure',
          risk: action.risk,
          details: {
            actionId: action.id,
            provenanceKind: action.provenance.kind,
            provider: result.provider,
            durationMs: result.durationMs,
            errorCode: result.error?.code
          }
        });
        send(res, result.ok ? 200 : 409, result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const code = message === 'REQUEST_TOO_LARGE' ? 'REQUEST_TOO_LARGE' : 'BAD_REQUEST';
        send(res, code === 'REQUEST_TOO_LARGE' ? 413 : 400, { ok: false, error: { code, message } });
      }
      return;
    }

    send(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Route not found.' } });
  });

  return {
    server,
    async listen(host = '127.0.0.1', port = 0): Promise<{ host: string; port: number }> {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve());
      });
      const address = server.address() as AddressInfo;
      return { host, port: address.port };
    },
    async close(): Promise<void> {
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}
