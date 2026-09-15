import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { ActionRisk } from '../../../src/core/types.ts';
import { PUBLIC_PLUGIN_TOOL_NAMES } from '../../../src/core/public-plugin-surface.ts';

type PublicInvoke = (
  capability: string,
  risk: ActionRisk,
  input: Record<string, unknown>,
  target?: string
) => Promise<any>;

export const PUBLIC_TOOL_NAMES = PUBLIC_PLUGIN_TOOL_NAMES;

export function registerPublicTools(
  server: McpServer,
  invoke: PublicInvoke,
  auth: { readScope: string; writeScope: string },
  bootstrap?: { claimDevice(userCode: string): Promise<any> }
): void {
  server.registerTool('device.claim', {
    title: 'Claim this Operator device',
    description: 'Claim a fresh Operator desktop using the short code shown locally. This bootstrap tool never accepts device IDs, keys, relay tokens, paths, commands, or capability lists.',
    inputSchema: z.object({ userCode: z.string().regex(/^[A-HJ-NP-Z2-9]{4}-?[A-HJ-NP-Z2-9]{4}$/i) }),
    _meta: { securitySchemes: oauthSchemes(auth.readScope, auth.writeScope) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ userCode }) => {
    if (!bootstrap) throw new Error('Device claim bootstrap is unavailable.');
    return bootstrap.claimDevice(userCode);
  });

  server.registerTool('computer.inspect', {
    title: 'Inspect computer capabilities',
    description: 'Inspect bounded capability and platform state for the authorized computer without reading project files or credentials.',
    inputSchema: z.object({}),
    _meta: { securitySchemes: oauthSchemes(auth.readScope) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async () => invoke('computer.inspect', 'read', {}));

  server.registerTool('project.inspect', {
    title: 'Inspect authorized project',
    description: 'Inspect bounded semantic metadata for an authorized project root.',
    inputSchema: z.object({ path: z.string().min(1).max(4096) }),
    _meta: { securitySchemes: oauthSchemes(auth.readScope) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ path }) => invoke('project.inspect', 'read', { path }, path));

  server.registerTool('project.commands', {
    title: 'List trusted project commands',
    description: 'List commands explicitly registered by the local Operator policy for this authorized project. This tool never executes them.',
    inputSchema: z.object({ path: z.string().min(1).max(4096) }),
    _meta: { securitySchemes: oauthSchemes(auth.readScope) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ path }) => invoke('project.command.inspect', 'read', { path }, path));

  server.registerTool('file.list', {
    title: 'List project directory',
    description: 'List a bounded directory inside an authorized project root. Credential-bearing paths are refused by the public boundary.',
    inputSchema: z.object({ path: z.string().min(1).max(4096) }),
    _meta: { securitySchemes: oauthSchemes(auth.readScope) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ path }) => invoke('file.list', 'read', { path }, path));

  server.registerTool('file.read', {
    title: 'Read safe project text file',
    description: 'Read a bounded UTF-8 text file inside an authorized project root. Secret and credential paths or detected restricted data are refused.',
    inputSchema: z.object({ path: z.string().min(1).max(4096) }),
    _meta: { securitySchemes: oauthSchemes(auth.readScope) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ path }) => invoke('file.read', 'read', { path, encoding: 'utf8' }, path));

  server.registerTool('file.create', {
    title: 'Create project file',
    description: 'Create a new UTF-8 project file. This tool refuses to overwrite an existing target and refuses restricted data.',
    inputSchema: z.object({ path: z.string().min(1).max(4096), content: z.string().max(131072) }),
    _meta: { securitySchemes: oauthSchemes(auth.readScope, auth.writeScope) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async ({ path, content }) => invoke('file.create', 'write', { path, content }, path));

  server.registerTool('file.replace', {
    title: 'Replace project file with precondition',
    description: 'Replace an existing UTF-8 project file only when its SHA-256 still matches a fresh file.read result.',
    inputSchema: z.object({
      path: z.string().min(1).max(4096),
      content: z.string().max(131072),
      expectedSha256: z.string().regex(/^[0-9a-f]{64}$/i)
    }),
    _meta: { securitySchemes: oauthSchemes(auth.readScope, auth.writeScope) },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ path, content, expectedSha256 }) => invoke('file.replace', 'destructive', { path, content, expectedSha256 }, path));

  server.registerTool('git.status', {
    title: 'Inspect Git status',
    description: 'Read repository status for an authorized project using Git directly.',
    inputSchema: z.object({ cwd: z.string().min(1).max(4096) }),
    _meta: { securitySchemes: oauthSchemes(auth.readScope) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ cwd }) => invoke('git.status', 'read', { cwd }, cwd));

  server.registerTool('git.diff', {
    title: 'Inspect safe Git diff',
    description: 'Read a bounded Git diff for an authorized project. Secret-bearing paths or detected restricted data are refused by the public boundary.',
    inputSchema: z.object({
      cwd: z.string().min(1).max(4096),
      paths: z.array(z.string().min(1).max(1000)).min(1).max(100)
    }),
    _meta: { securitySchemes: oauthSchemes(auth.readScope) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ cwd, paths }) => {
    for (const item of paths) {
      const normalized = item.replace(/\\/g, '/');
      if (item.startsWith('/') || /^[A-Za-z]:[\\/]/.test(item) || normalized === '.' || normalized === '..' || normalized.startsWith(':') || /[*?\[\]{}]/.test(normalized)) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: 'git.diff: path filters must be project-relative.' }],
          structuredContent: { ok: false, capability: 'git.diff', error: { code: 'PUBLIC_PATH_FILTER_INVALID', message: 'Git path filters must be project-relative.', retryable: false } }
        };
      }
    }
    return invoke('git.diff', 'read', { cwd, paths, publicLiteralFiles: true }, cwd);
  });
  installPublicToolSecurityProjection(server);
}

function oauthSchemes(...scopes: string[]) {
  return [{ type: 'oauth2' as const, scopes }];
}

type PublicRegisteredTool = {
  enabled: boolean;
  title?: string;
  description?: string;
  annotations?: Record<string, unknown>;
  icons?: unknown;
  execution?: unknown;
  _meta?: Record<string, unknown>;
};

type PublicMcpServerInternals = {
  server: McpServer['server'];
  _registeredTools: Record<string, PublicRegisteredTool>;
  toolInputSchemaJson(name: string): unknown;
};

function installPublicToolSecurityProjection(server: McpServer): void {
  const internal = server as unknown as PublicMcpServerInternals;
  server.server.removeRequestHandler('tools/list');
  server.server.setRequestHandler('tools/list', (() => ({
    tools: Object.entries(internal._registeredTools)
      .filter(([, tool]) => tool.enabled)
      .map(([name, tool]) => publicToolDefinition(internal, name, tool))
  })) as any);
}

function publicToolDefinition(
  server: PublicMcpServerInternals,
  name: string,
  tool: PublicRegisteredTool
): Record<string, unknown> {
  const securitySchemes = validatedSecuritySchemes(tool._meta?.securitySchemes);
  return {
    name,
    title: tool.title,
    description: tool.description,
    inputSchema: server.toolInputSchemaJson(name) ?? { type: 'object', properties: {} },
    securitySchemes,
    annotations: tool.annotations,
    icons: tool.icons,
    execution: tool.execution,
    _meta: tool._meta
  };
}

function validatedSecuritySchemes(input: unknown): Array<{ type: 'oauth2'; scopes: string[] }> {
  if (!Array.isArray(input) || input.length !== 1) throw new Error('Public tool OAuth metadata is missing.');
  const scheme = input[0] as Record<string, unknown>;
  if (scheme?.type !== 'oauth2' || !Array.isArray(scheme.scopes) || scheme.scopes.length < 1) {
    throw new Error('Public tool OAuth metadata is invalid.');
  }
  const scopes = scheme.scopes.map((scope) => String(scope));
  if (scopes.some((scope) => !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(scope))) {
    throw new Error('Public tool OAuth scope metadata is invalid.');
  }
  return [{ type: 'oauth2', scopes: [...new Set(scopes)] }];
}
