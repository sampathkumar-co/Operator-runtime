import http from 'node:http';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { ActionRequest, PermissionProfile } from '../../../src/core/types.ts';
import type { OperatorRuntime } from '../../../src/core/runtime.ts';

const MAX_BODY_BYTES = 1024 * 1024;

function timingSafeTokenMatch(actual: string | undefined, expected: string): boolean {
  if (!actual?.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(actual.slice('Bearer '.length));
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
}) {
  if (options.token.length < 32) throw new Error('Agent token must be at least 32 characters.');

  const server = http.createServer(async (req, res) => {
    if (req.url === '/health' && req.method === 'GET') {
      send(res, 200, { ok: true, service: 'operator-local-agent', version: '0.1.0' });
      return;
    }

    if (!timingSafeTokenMatch(req.headers.authorization, options.token)) {
      send(res, 401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'Valid agent bearer token required.' } });
      return;
    }

    if (req.url === '/v1/execute' && req.method === 'POST') {
      try {
        const body = await readJson(req) as { action?: ActionRequest };
        if (!body.action || typeof body.action !== 'object') {
          send(res, 400, { ok: false, error: { code: 'INVALID_REQUEST', message: 'action is required.' } });
          return;
        }
        const result = await options.runtime.execute(body.action, options.permissions);
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
