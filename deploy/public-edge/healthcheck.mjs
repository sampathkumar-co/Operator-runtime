import process from 'node:process';
import { loopbackHttpStatus } from './http-probe.mjs';

async function requireOk(url, headers = {}) {
  const status = await loopbackHttpStatus(url, { headers, timeoutMs: 2_000 });
  if (status < 200 || status >= 300) throw new Error(`${url} returned HTTP ${status}`);
}

try {
  const publicUrl = new URL(process.env.OPERATOR_MCP_PUBLIC_URL ?? '');
  await Promise.all([
    requireOk('http://127.0.0.1:8788/health'),
    requireOk('http://127.0.0.1:8789/health'),
    requireOk('http://127.0.0.1:8790/health'),
    requireOk('http://127.0.0.1:47200/health', { host: publicUrl.host })
  ]);
  process.exit(0);
} catch (error) {
  process.stderr.write(`[operator-edge-health] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}