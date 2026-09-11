import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { TOOL_NAMES } from '../src/tool-surface.ts';

type ToolLike = {
  name?: unknown;
  inputSchema?: unknown;
  annotations?: Record<string, unknown>;
};

const ANNOTATION_KEYS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const;

export function requireLocalMcpUrl(raw = 'http://127.0.0.1:47200/mcp'): URL {
  const url = new URL(raw);
  if (url.protocol !== 'http:') throw new Error('Local certification preflight requires loopback HTTP; TLS belongs at the supported tunnel boundary.');
  if (url.username || url.password) throw new Error('MCP URL must not embed credentials.');
  if (url.search || url.hash) throw new Error('MCP URL must not contain query or fragment data.');
  if (!['127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Local certification preflight requires a literal loopback MCP host.');
  if (url.pathname !== '/mcp') throw new Error('Local certification preflight expects the MCP endpoint at /mcp.');
  return url;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  const object = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(object).sort().map((key) => [key, canonicalize(object[key])]));
}

export function validateAndFingerprintTools(tools: ToolLike[]): { count: number; names: string[]; sha256: string } {
  const names = tools.map((tool) => String(tool.name ?? '')).sort();
  if (new Set(names).size !== names.length) throw new Error('MCP tool enumeration contains duplicate names.');
  if (JSON.stringify(names) !== JSON.stringify(TOOL_NAMES)) {
    throw new Error(`MCP tool enumeration drifted from the canonical Operator surface. expected=${TOOL_NAMES.join(',')} actual=${names.join(',')}`);
  }
  for (const tool of tools) {
    for (const key of ANNOTATION_KEYS) {
      if (typeof tool.annotations?.[key] !== 'boolean') throw new Error(`MCP tool ${String(tool.name)} is missing boolean annotation ${key}.`);
    }
  }
  const contract = tools.map((tool) => ({
    name: String(tool.name),
    annotations: Object.fromEntries(ANNOTATION_KEYS.map((key) => [key, tool.annotations?.[key]])),
    inputSchema: canonicalize(tool.inputSchema)
  })).sort((a, b) => a.name.localeCompare(b.name));
  const sha256 = crypto.createHash('sha256').update(JSON.stringify(contract)).digest('hex');
  return { count: names.length, names, sha256 };
}

function repositoryCommit(): string | null {
  try {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 3000 }).trim().toLowerCase();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

export async function runLocalCertificationPreflight(rawUrl = process.env.OPERATOR_MCP_URL): Promise<Record<string, unknown>> {
  const mcpUrl = requireLocalMcpUrl(rawUrl);
  const healthUrl = new URL('/health', mcpUrl);
  const healthResponse = await fetch(healthUrl, { signal: AbortSignal.timeout(3000) });
  if (!healthResponse.ok) throw new Error(`MCP health check failed with HTTP ${healthResponse.status}.`);
  const health = await healthResponse.json() as Record<string, unknown>;
  if (health.ok !== true || health.service !== 'operator-mcp-server') throw new Error('MCP health response did not identify a ready Operator MCP server.');

  const client = new Client({ name: 'operator-live-cert-preflight', version: '0.1.0' }, { versionNegotiation: { mode: 'auto' } });
  const transport = new StreamableHTTPClientTransport(mcpUrl);
  await client.connect(transport);
  try {
    const listed = await client.listTools();
    const surface = validateAndFingerprintTools(listed.tools as ToolLike[]);
    const probe = await client.callTool({ name: 'computer.inspect', arguments: {} });
    const structured = probe.structuredContent as Record<string, unknown> | undefined;
    if (probe.isError === true || structured?.ok !== true || structured?.capability !== 'computer.inspect') {
      throw new Error('MCP computer.inspect read probe did not return a verified successful Operator result.');
    }
    const serializedProbe = JSON.stringify(structured);
    if (/BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|"(?:password|privateKey|recoveryToken|bearerToken)"\s*:/i.test(serializedProbe)) {
      throw new Error('MCP read probe contained a secret-like field and cannot be retained as certification evidence.');
    }
    return {
      schemaVersion: 1,
      generatedAtUtc: new Date().toISOString(),
      commitSha: repositoryCommit(),
      mcp: {
        health: 'PASS',
        service: health.service,
        version: health.version ?? null,
        transport: 'streamable-http',
        localBind: 'loopback-only',
        toolCount: surface.count,
        toolSurfaceSha256: surface.sha256,
        toolNames: surface.names
      },
      readProbe: {
        status: 'PASS',
        tool: 'computer.inspect',
        provider: structured.provider ?? null,
        evidenceCount: Array.isArray(structured.evidence) ? structured.evidence.length : 0
      },
      externalGates: {
        secureMcpTunnel: 'NOT_RUN',
        realChatGPTReadWorkflow: 'NOT_RUN'
      }
    };
  } finally {
    await client.close();
  }
}

const isEntrypoint = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isEntrypoint) {
  const receipt = await runLocalCertificationPreflight();
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}