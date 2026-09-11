import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { requireLocalMcpUrl } from './live-cert-preflight.ts';

const execFileAsync = promisify(execFile);
const TUNNEL_ID = /^tunnel_[0-9a-f]{32}$/;
const MAX_CHILD_OUTPUT = 256 * 1024;

export const CERTIFIED_TUNNEL_CLIENT = {
  version: '0.0.14',
  platform: 'win32',
  arch: 'x64',
  archiveSha256: '784ab8da7b5a88f0109f1fd8aaf0a1c86067430b896dddf307ef7e3cc49fa1a5',
  executableSha256: 'fcc85a69ec0ad82518e4f8964f60c45e31787957782a0fc9c1b0c44e82d61b9b'
} as const;

export type TunnelCredentialStatus = {
  tunnelId: string | null;
  hasRuntimeApiKey: boolean;
  missing: string[];
};

export function readTunnelCredentialStatus(env: NodeJS.ProcessEnv = process.env): TunnelCredentialStatus {
  const rawTunnelId = env.CONTROL_PLANE_TUNNEL_ID?.trim() || '';
  if (rawTunnelId && !TUNNEL_ID.test(rawTunnelId)) {
    throw new Error('CONTROL_PLANE_TUNNEL_ID must match tunnel_<32 lowercase hex>.');
  }
  const hasRuntimeApiKey = Boolean(env.CONTROL_PLANE_API_KEY?.trim());
  const missing: string[] = [];
  if (!rawTunnelId) missing.push('CONTROL_PLANE_TUNNEL_ID');
  if (!hasRuntimeApiKey) missing.push('CONTROL_PLANE_API_KEY');
  return { tunnelId: rawTunnelId || null, hasRuntimeApiKey, missing };
}

export function buildTunnelDoctorArgs(mcpUrl: URL, tunnelId: string): string[] {
  if (!TUNNEL_ID.test(tunnelId)) throw new Error('A valid tunnel ID is required before running tunnel-client doctor.');
  return [
    'doctor',
    '--mcp.server-url', `url=${mcpUrl.href}`,
    '--health.listen-addr', '127.0.0.1:0',
    '--control-plane.tunnel-id', tunnelId,
    '--control-plane.api-key', 'env:CONTROL_PLANE_API_KEY',
    '--json',
    '--explain'
  ];
}

export function validateTunnelClientVersion(version: string, platform = process.platform, arch = process.arch): void {
  if (platform !== CERTIFIED_TUNNEL_CLIENT.platform || arch !== CERTIFIED_TUNNEL_CLIENT.arch) {
    throw new Error(`Secure tunnel certification currently pins ${CERTIFIED_TUNNEL_CLIENT.platform}/${CERTIFIED_TUNNEL_CLIENT.arch}; got ${platform}/${arch}.`);
  }
  if (!version.startsWith(`${CERTIFIED_TUNNEL_CLIENT.version}+`)) {
    throw new Error(`Secure tunnel certification requires tunnel-client ${CERTIFIED_TUNNEL_CLIENT.version}; got ${version || 'no version'}.`);
  }
}

async function requireTunnelClient(raw = process.env.OPERATOR_TUNNEL_CLIENT_PATH): Promise<{ path: string; sha256: string }> {
  const input = raw?.trim();
  if (!input || !path.isAbsolute(input)) {
    throw new Error('OPERATOR_TUNNEL_CLIENT_PATH must be an absolute path to the official tunnel-client binary.');
  }
  const stat = await fs.stat(input);
  if (!stat.isFile()) throw new Error('OPERATOR_TUNNEL_CLIENT_PATH must point to a regular file.');
  const resolved = path.resolve(input);
  const sha256 = crypto.createHash('sha256').update(await fs.readFile(resolved)).digest('hex');
  if (sha256 !== CERTIFIED_TUNNEL_CLIENT.executableSha256) {
    throw new Error(`tunnel-client executable SHA-256 did not match the binary derived from the certified OpenAI ${CERTIFIED_TUNNEL_CLIENT.version} Windows amd64 archive.`);
  }
  return { path: resolved, sha256 };
}

async function requireHealthyMcp(mcpUrl: URL): Promise<Record<string, unknown>> {
  const response = await fetch(new URL('/health', mcpUrl), { signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error(`MCP health check failed with HTTP ${response.status}.`);
  const health = await response.json() as Record<string, unknown>;
  if (health.ok !== true || health.service !== 'operator-mcp-server') {
    throw new Error('MCP health response did not identify a ready Operator MCP server.');
  }
  return health;
}

type ChildResult = { code: number; stdout: string; stderr: string };

export function buildTunnelChildEnv(env: NodeJS.ProcessEnv = process.env, includeRuntimeKey = false): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  const names = [
    'PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP',
    'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'HOME',
    'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'
  ];
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value !== '') out[name] = value;
  }
  if (includeRuntimeKey && env.CONTROL_PLANE_API_KEY) out.CONTROL_PLANE_API_KEY = env.CONTROL_PLANE_API_KEY;
  return out;
}

async function runBounded(executable: string, args: string[], env = process.env): Promise<ChildResult> {
  try {
    const result = await execFileAsync(executable, args, {
      env,
      encoding: 'utf8',
      timeout: 20_000,
      windowsHide: true,
      maxBuffer: MAX_CHILD_OUTPUT
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    const code = typeof failure.code === 'number' ? failure.code : 1;
    return { code, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

export function assertDoctorOutputSecretSafe(stdout: string, stderr: string, secret: string): void {
  if (!secret) throw new Error('Runtime API key must be non-empty before inspecting tunnel-client output.');
  if (stdout.includes(secret) || stderr.includes(secret)) {
    throw new Error('tunnel-client output contained the runtime API key; certification evidence was discarded.');
  }
}

export function parseDoctorSummary(text: string): Record<string, unknown> {
  const value = JSON.parse(text) as { result?: unknown; failed_checks?: unknown; checks?: unknown };
  const checks = Array.isArray(value.checks) ? value.checks : [];
  return {
    result: value.result ?? 'unknown',
    failedChecks: Array.isArray(value.failed_checks) ? value.failed_checks : [],
    checks: checks.map((entry) => {
      const check = entry as Record<string, unknown>;
      return { id: check.id ?? null, status: check.status ?? null, summary: check.summary ?? null };
    })
  };
}

export async function runSecureTunnelPreflight(
  rawMcpUrl = process.env.OPERATOR_MCP_URL,
  env: NodeJS.ProcessEnv = process.env
): Promise<Record<string, unknown>> {
  const mcpUrl = requireLocalMcpUrl(rawMcpUrl);
  const tunnelClient = await requireTunnelClient(env.OPERATOR_TUNNEL_CLIENT_PATH);
  const health = await requireHealthyMcp(mcpUrl);
  const versionResult = await runBounded(tunnelClient.path, ['--version'], buildTunnelChildEnv(env, false));
  if (versionResult.code !== 0) throw new Error('Official tunnel-client did not return a version successfully.');
  const version = versionResult.stdout.trim().slice(0, 200);
  validateTunnelClientVersion(version);
  const credentials = readTunnelCredentialStatus(env);

  const baseReceipt = {
    schemaVersion: 1,
    generatedAtUtc: new Date().toISOString(),
    tunnelClient: {
      version,
      executableSha256: tunnelClient.sha256,
      certifiedArchiveSha256: CERTIFIED_TUNNEL_CLIENT.archiveSha256,
      pathConfigured: true
    },
    mcp: { health: 'PASS', service: health.service, localUrl: mcpUrl.href }
  };

  if (credentials.missing.length > 0) {
    return {
      ...baseReceipt,
      status: 'BLOCKED',
      credentials: {
        tunnelIdConfigured: Boolean(credentials.tunnelId),
        runtimeApiKeyConfigured: credentials.hasRuntimeApiKey,
        missing: credentials.missing
      },
      next: 'Create/authorize a Platform tunnel and runtime API key, export them only in the local process environment, then rerun npm run certify:tunnel.'
    };
  }

  const apiKey = env.CONTROL_PLANE_API_KEY!;
  const doctorResult = await runBounded(
    tunnelClient.path,
    buildTunnelDoctorArgs(mcpUrl, credentials.tunnelId!),
    buildTunnelChildEnv(env, true)
  );
  assertDoctorOutputSecretSafe(doctorResult.stdout, doctorResult.stderr, apiKey);
  const doctor = parseDoctorSummary(doctorResult.stdout);
  return {
    ...baseReceipt,
    status: doctorResult.code === 0 && doctor.result === 'pass' ? 'PASS' : 'FAIL',
    credentials: { tunnelIdConfigured: true, runtimeApiKeyConfigured: true, missing: [] },
    doctor
  };
}

const isEntrypoint = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isEntrypoint) {
  try {
    const receipt = await runSecureTunnelPreflight();
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
    if (receipt.status === 'BLOCKED') process.exitCode = 2;
    else if (receipt.status !== 'PASS') process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`operator-secure-tunnel-preflight:FAIL ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
