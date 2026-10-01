import crypto from 'node:crypto';
import { createMcpFastifyApp } from '@modelcontextprotocol/fastify';
import { toNodeHandler, toWebRequest } from '@modelcontextprotocol/node';
import {
  bearerAuthChallengeResponse,
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  hostHeaderValidationResponse,
  McpServer,
  oauthMetadataResponse,
  originValidationResponse,
  verifyBearerToken,
  type AuthInfo
} from '@modelcontextprotocol/server';
import type { FastifyReply } from 'fastify';
import * as z from 'zod/v4';
import { LocalAgentClient } from './local-agent-client.ts';
import { mcpInvocationScope, withMcpInvocation } from './request-context.ts';
import { principalFromAuthInfo, readPublicMcpEdgeConfig, resolveMcpBindHost } from './public-edge.ts';
import type { ActionRequest, ActionRisk } from '../../../src/core/types.ts';
import { stableActionId } from '../../../src/core/action-identity.ts';
import { invokePublicWithAgent } from './public-boundary.ts';
import { registerPublicTools } from './public-tools.ts';
import { FixedWindowRateLimiter, envRateLimit, principalRateKey, requestClientKey, type RateLimitDecision } from './rate-limit.ts';
import { loadPublicServicePages, PUBLIC_SERVICE_PAGE_PATHS } from './public-pages.ts';
import { PRODUCT_NAME, PRODUCT_TITLE, PRODUCT_VERSION } from '../../../src/core/product-identity.ts';
import { PUBLIC_PLUGIN_SURFACE_VERSION, PUBLIC_PLUGIN_TOOL_NAMES } from '../../../src/core/public-plugin-surface.ts';
import { TOOL_NAMES } from './tool-surface.ts';

const agentUrl = process.env.OPERATOR_AGENT_URL ?? 'http://127.0.0.1:47100';
const agentToken = process.env.OPERATOR_AGENT_TOKEN?.trim() ?? '';
const executionMode = (process.env.OPERATOR_EXECUTION_MODE ?? 'local').trim().toLowerCase();
const publicEdge = readPublicMcpEdgeConfig();
const developerEdge = process.env.OPERATOR_MCP_DEVELOPER_EDGE?.trim() === '1';
if (developerEdge && !publicEdge?.developerScope) throw new Error('Developer MCP edge requires a dedicated OAuth developer scope.');
const publicRequestLimiter = publicEdge ? new FixedWindowRateLimiter({
  limit: envRateLimit(process.env.OPERATOR_PUBLIC_REQUESTS_PER_MINUTE, 600, 'OPERATOR_PUBLIC_REQUESTS_PER_MINUTE'),
  windowMs: 60_000
}) : null;
const publicAuthFailureLimiter = publicEdge ? new FixedWindowRateLimiter({
  limit: envRateLimit(process.env.OPERATOR_PUBLIC_AUTH_FAILURES_PER_5_MINUTES, 30, 'OPERATOR_PUBLIC_AUTH_FAILURES_PER_5_MINUTES'),
  windowMs: 5 * 60_000
}) : null;
const publicPrincipalLimiter = publicEdge ? new FixedWindowRateLimiter({
  limit: envRateLimit(process.env.OPERATOR_PUBLIC_PRINCIPAL_REQUESTS_PER_MINUTE, 300, 'OPERATOR_PUBLIC_PRINCIPAL_REQUESTS_PER_MINUTE'),
  windowMs: 60_000
}) : null;
if (executionMode === 'local' && agentToken.length < 32) {
  throw new Error('OPERATOR_AGENT_TOKEN must be set and match the local agent token.');
}
if (publicEdge && (process.env.OPERATOR_RELAY_CONTROL_TOKEN?.trim().length ?? 0) < 32) {
  throw new Error('Public MCP edge requires OPERATOR_RELAY_CONTROL_TOKEN with at least 32 characters.');
}
const port = Number(process.env.OPERATOR_MCP_PORT ?? 47200);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('OPERATOR_MCP_PORT must be an integer between 1 and 65535.');
const host = resolveMcpBindHost(process.env, publicEdge);

const handler = createMcpHandler(({ authInfo }) => {
  const principal = publicEdge ? principalFromAuthInfo(authInfo, publicEdge.publicUrl) : undefined;
  return createServer(new LocalAgentClient(agentUrl, agentToken, principal), authInfo);
});
const nodeHandler = toNodeHandler(handler);
const app = createMcpFastifyApp(publicEdge
  ? { host, allowedHosts: publicEdge.allowedHostnames, allowedOrigins: publicEdge.allowedHostnames }
  : { host });

if (publicEdge) {
  const publicServicePages = loadPublicServicePages(process.env);
  if (publicEdge.challengeToken) {
    app.get('/.well-known/openai-apps-challenge', async (request, reply) => {
      const webRequest = await toWebRequest(request.raw, request.body);
      const rejected = validatePublicHeaders(webRequest);
      if (rejected) return sendSdkResponse(reply, rejected);
      return reply.header('cache-control', 'no-store').type('text/plain; charset=utf-8').send(publicEdge.challengeToken);
    });
  }

  for (const pagePath of PUBLIC_SERVICE_PAGE_PATHS) {
    app.get(pagePath, async (request, reply) => {
      const webRequest = await toWebRequest(request.raw, request.body);
      const rejected = validatePublicHeaders(webRequest);
      if (rejected) return sendSdkResponse(reply, rejected);
      return reply
        .header('cache-control', 'public, max-age=300')
        .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'")
        .header('cross-origin-resource-policy', 'same-origin')
        .header('x-content-type-options', 'nosniff')
        .header('x-frame-options', 'DENY')
        .header('x-robots-tag', 'index, follow')
        .type('text/html; charset=utf-8')
        .send(publicServicePages[pagePath]);
    });
  }

  const metadataPaths = ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-authorization-server'];
  for (const metadataPath of metadataPaths) {
    app.all(metadataPath, async (request, reply) => {
      const webRequest = await toWebRequest(request.raw, request.body);
      const rejected = validatePublicHeaders(webRequest);
      if (rejected) return sendSdkResponse(reply, rejected);
      const response = oauthMetadataResponse(webRequest, publicEdge.authMetadata);
      if (!response) return reply.code(404).send({ error: 'not_found' });
      return sendSdkResponse(reply, response);
    });
  }

  if (!developerEdge) app.post('/pair/api/claim', async (request, reply) => {
    const webRequest = await toWebRequest(request.raw, request.body);
    const rejected = validatePublicHeaders(webRequest);
    if (rejected) return sendSdkResponse(reply, rejected);

    const clientKey = requestClientKey(request.raw);
    const requestDecision = publicRequestLimiter!.hit(clientKey);
    if (!requestDecision.allowed) return sendRateLimit(reply, requestDecision);
    const failureDecision = publicAuthFailureLimiter!.isLimited(clientKey);
    if (!failureDecision.allowed) return sendRateLimit(reply, failureDecision);

    const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(publicEdge.publicUrl);
    let authInfo: AuthInfo;
    try {
      authInfo = await verifyBearerToken(request.headers.authorization, {
        verifier: publicEdge.verifier,
        requiredScopes: [publicEdge.writeScope],
        resourceMetadataUrl
      });
    } catch (error) {
      const failed = publicAuthFailureLimiter!.hit(clientKey);
      if (!failed.allowed) return sendRateLimit(reply, failed);
      return sendSdkResponse(reply, bearerAuthChallengeResponse(error, {
        requiredScopes: [publicEdge.writeScope],
        resourceMetadataUrl
      }));
    }
    publicAuthFailureLimiter!.clear(clientKey);

    const principal = principalFromAuthInfo(authInfo, publicEdge.publicUrl);
    const principalDecision = publicPrincipalLimiter!.hit(principalRateKey(principal.issuer, principal.subject));
    if (!principalDecision.allowed) return sendRateLimit(reply, principalDecision);

    const body = request.body as { userCode?: unknown; makeDefault?: unknown } | undefined;
    const compact = typeof body?.userCode === 'string'
      ? body.userCode.toUpperCase().replace(/[^A-Z0-9]/g, '')
      : '';
    if (!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(compact)) {
      return reply.header('cache-control', 'no-store').code(400).send({
        ok: false,
        error: { code: 'DEVICE_ENROLLMENT_CODE_INVALID', message: 'Pairing code is invalid or expired.' }
      });
    }
    const userCode = `${compact.slice(0, 4)}-${compact.slice(4)}`;

    try {
      const agent = new LocalAgentClient(agentUrl, agentToken, principal);
      const result = await agent.claimDevice(userCode, body?.makeDefault === true);
      return reply.header('cache-control', 'no-store').code(200).send({ ok: true, status: result.status });
    } catch (error) {
      const code = typeof (error as { code?: unknown })?.code === 'string'
        ? String((error as { code: string }).code)
        : 'DEVICE_ENROLLMENT_CLAIM_FAILED';
      const safeCode = [
        'DEVICE_ENROLLMENT_CODE_INVALID',
        'DEVICE_ENROLLMENT_EXPIRED',
        'DEVICE_ENROLLMENT_ALREADY_CLAIMED',
        'DEVICE_ALREADY_OWNED',
        'ACCOUNT_DISABLED',
        'ACCOUNT_ERASING'
      ].includes(code) ? code : 'DEVICE_ENROLLMENT_CLAIM_FAILED';
      return reply.header('cache-control', 'no-store').code(409).send({
        ok: false,
        error: { code: safeCode, message: 'Device pairing could not be completed.' }
      });
    }
  });
}

app.all('/mcp', async (request, reply) => {
  let invocationScope = mcpInvocationScope(request.headers['mcp-session-id']);
  if (publicEdge) {
    const webRequest = await toWebRequest(request.raw, request.body);
    const rejected = validatePublicHeaders(webRequest);
    if (rejected) return sendSdkResponse(reply, rejected);
    const clientKey = requestClientKey(request.raw);
    const requestDecision = publicRequestLimiter!.hit(clientKey);
    if (!requestDecision.allowed) return sendRateLimit(reply, requestDecision);
    const failureDecision = publicAuthFailureLimiter!.isLimited(clientKey);
    if (!failureDecision.allowed) return sendRateLimit(reply, failureDecision);
    const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(publicEdge.publicUrl);
    let authInfo: AuthInfo;
    try {
      authInfo = await verifyBearerToken(request.headers.authorization, {
        verifier: publicEdge.verifier,
        requiredScopes: developerEdge ? [publicEdge.developerScope!] : publicEdge.requiredScopes,
        resourceMetadataUrl
      });
    } catch (error) {
      const failed = publicAuthFailureLimiter!.hit(clientKey);
      if (!failed.allowed) return sendRateLimit(reply, failed);
      return sendSdkResponse(reply, bearerAuthChallengeResponse(error, {
        requiredScopes: developerEdge ? [publicEdge.developerScope!] : publicEdge.requiredScopes,
        resourceMetadataUrl
      }));
    }
    publicAuthFailureLimiter!.clear(clientKey);
    invocationScope = mcpInvocationScope(request.headers['mcp-session-id'], authInfo.clientId);
    const principal = principalFromAuthInfo(authInfo, publicEdge.publicUrl);
    const principalDecision = publicPrincipalLimiter!.hit(principalRateKey(principal.issuer, principal.subject));
    if (!principalDecision.allowed) return sendRateLimit(reply, principalDecision);
    delete request.raw.headers.authorization;
    (request.raw as typeof request.raw & { auth?: AuthInfo }).auth = authInfo;
  }
  return withMcpInvocation(request.body, invocationScope, () => nodeHandler(request.raw, reply.raw, request.body));
});
app.get('/health', async () => ({
  ok: true,
  service: PRODUCT_NAME,
  title: PRODUCT_TITLE,
  version: PRODUCT_VERSION,
  toolSurface: developerEdge ? 'developer' : publicEdge ? 'public' : 'local-private',
  toolCount: developerEdge ? TOOL_NAMES.length : publicEdge ? PUBLIC_PLUGIN_TOOL_NAMES.length : TOOL_NAMES.length,
  ...(developerEdge || !publicEdge ? {} : {
    publicToolSurfaceVersion: PUBLIC_PLUGIN_SURFACE_VERSION,
    publicToolCount: PUBLIC_PLUGIN_TOOL_NAMES.length
  }),
  ...runtimeProvenance(process.env)
}));

await app.listen({ host, port });
if (publicEdge) console.error(`[operator] ${developerEdge ? 'developer' : 'public'} MCP edge listening behind trusted TLS proxy for ${publicEdge.publicUrl.toString()}`);
else console.error(`[operator] MCP server listening on http://${host}:${port}/mcp`);

function validatePublicHeaders(request: Request): Response | undefined {
  if (!publicEdge) return undefined;
  return hostHeaderValidationResponse(request, publicEdge.allowedHostnames)
    ?? originValidationResponse(request, publicEdge.allowedHostnames);
}

function runtimeProvenance(env: NodeJS.ProcessEnv): { sourceCommit: string; buildTimestamp: string } {
  const sourceCommit = /^[0-9a-f]{40}$/i.test(env.OPERATOR_SOURCE_COMMIT ?? '')
    ? env.OPERATOR_SOURCE_COMMIT!.toLowerCase()
    : 'unknown';
  const buildTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(env.OPERATOR_BUILD_TIMESTAMP ?? '')
    ? env.OPERATOR_BUILD_TIMESTAMP!
    : 'unknown';
  return { sourceCommit, buildTimestamp };
}

async function sendSdkResponse(reply: FastifyReply, response: Response): Promise<FastifyReply> {
  reply.code(response.status);
  for (const [name, value] of response.headers) reply.header(name, value);
  const body = await response.text();
  return body ? reply.send(body) : reply.send();
}


function sendRateLimit(reply: FastifyReply, decision: RateLimitDecision): FastifyReply {
  reply.header('retry-after', String(decision.retryAfterSeconds));
  reply.header('cache-control', 'no-store');
  return reply.code(429).send({ error: 'rate_limited' });
}

function createServer(agent: LocalAgentClient, authInfo?: AuthInfo): McpServer {
  const publicMode = Boolean(publicEdge) && !developerEdge;
  const invoke = (capability: string, risk: ActionRisk, input: Record<string, unknown>, target?: string) =>
    publicMode
      ? invokePublicWithAgent(agent, capability, risk, input, target, {
          grantedScopes: authInfo?.scopes,
          readScope: publicEdge?.readScope,
          writeScope: publicEdge?.writeScope,
          resourceMetadataUrl: publicEdge ? getOAuthProtectedResourceMetadataUrl(publicEdge.publicUrl).toString() : undefined
        })
      : invokeWithAgent(agent, capability, risk, input, target);

  const server = new McpServer(
    { name: PRODUCT_NAME, title: PRODUCT_TITLE, version: PRODUCT_VERSION },
    { capabilities: { tools: {} }, instructions: publicMode
      ? 'Operate only user-authorized project data through the restricted public tool surface. Never request or process credentials, authentication secrets, payment data, or other restricted data.'
      : developerEdge
        ? 'Developer-only Mecord surface. Operate only the authenticated developer account and user-authorized computers. All actions remain subject to local roots, capability policy, session approval, and emergency stop.'
        : 'Operate only user-authorized computers. Prefer semantic/native capabilities and return evidence-rich results.' }
  );

  if (publicMode) {
    registerPublicTools(server, invoke, { readScope: publicEdge!.readScope, writeScope: publicEdge!.writeScope });
    return server;
  }

  const taskUuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  const taskSelector = z.object({
    name: z.string().min(1).max(512).optional(), automationId: z.string().min(1).max(512).optional(),
    className: z.string().min(1).max(512).optional(), controlType: z.string().min(1).max(128).optional(),
    processId: z.number().int().positive().optional()
  }).refine((selector) => Object.values(selector).some((value) => value !== undefined), 'At least one semantic selector field is required.');
  const visualTaskSelector = z.object({
    name: z.string().min(1).max(512).optional(), className: z.string().min(1).max(512).optional(),
    processId: z.number().int().positive().optional()
  }).refine((selector) => Object.values(selector).some((value) => value !== undefined), 'At least one visual window selector field is required.');
  const taskPhysicalFallback = z.object({
    source: z.enum(['screen', 'window', 'region']),
    selector: visualTaskSelector.optional(),
    region: z.object({
      x: z.number().int().min(-100000).max(100000), y: z.number().int().min(-100000).max(100000),
      width: z.number().int().min(1).max(16384), height: z.number().int().min(1).max(16384)
    }).optional(),
    operation: z.enum(['move', 'click', 'double_click', 'drag', 'scroll', 'type_text', 'key_press', 'hotkey']),
    x: z.number().int().min(0).max(1279).optional(), y: z.number().int().min(0).max(719).optional(),
    toX: z.number().int().min(0).max(1279).optional(), toY: z.number().int().min(0).max(719).optional(),
    deltaX: z.number().int().min(-1200).max(1200).optional(), deltaY: z.number().int().min(-1200).max(1200).optional(),
    text: z.string().max(4096).optional(), key: z.string().min(1).max(32).optional(),
    keys: z.array(z.string().min(1).max(32)).min(1).max(4).optional(),
    maxWidth: z.number().int().min(1).max(1280).optional(), maxHeight: z.number().int().min(1).max(720).optional()
  });
  const atomicTaskGoal = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('controlled-file-change'), root: z.string().min(1).max(4096), path: z.string().min(1).max(4096), content: z.string().max(256 * 1024) }),
    z.object({ kind: z.literal('trusted-project-command'), root: z.string().min(1).max(4096), commandKind: z.enum(['build', 'test', 'lint']) }),
    z.object({ kind: z.literal('browser-navigation'), url: z.string().min(1).max(8192), targetId: z.string().min(1).max(512).optional() }),
    z.object({ kind: z.literal('docker-lifecycle'), root: z.string().min(1).max(4096), operation: z.enum(['start', 'stop', 'restart']), services: z.array(z.string().min(1).max(256)).min(1).max(100), timeoutMs: z.number().int().min(100).max(30 * 60_000).optional() }),
    z.object({
      kind: z.literal('postgres-select'), root: z.string().min(1).max(4096), profileId: z.string().min(1).max(256), schema: z.string().min(1).max(128).optional(), table: z.string().min(1).max(128),
      columns: z.array(z.string().min(1).max(128)).max(50).optional(),
      filters: z.array(z.object({ column: z.string().min(1).max(128), op: z.enum(['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'like', 'ilike', 'is_null', 'not_null']), value: z.string().max(16_384).optional() })).max(20).optional(),
      orderBy: z.array(z.object({ column: z.string().min(1).max(128), direction: z.enum(['asc', 'desc']) })).max(5).optional(),
      limit: z.number().int().min(1).max(500).optional(), offset: z.number().int().min(0).max(10_000).optional(), timeoutMs: z.number().int().min(100).max(30_000).optional()
    }),
    z.object({
      kind: z.literal('app-operation'), operation: z.enum(['invoke', 'set_value', 'focus', 'select', 'expand', 'collapse', 'scroll', 'activate_window']), selector: taskSelector,
      value: z.string().max(65_536).optional(), horizontalAmount: z.enum(['large_decrement', 'small_decrement', 'none', 'large_increment', 'small_increment']).optional(),
      verticalAmount: z.enum(['large_decrement', 'small_decrement', 'none', 'large_increment', 'small_increment']).optional(), verifySelector: taskSelector.optional(), waitMs: z.number().int().min(0).max(10_000).optional(),
      physicalFallback: taskPhysicalFallback.optional()
    })
  ]);
  const taskGoal = z.union([
    atomicTaskGoal,
    z.object({
      kind: z.literal('project-quality-gate'),
      root: z.string().min(1).max(4096),
      checks: z.array(z.enum(['lint', 'test', 'build'])).min(1).max(3).optional(),
      requireAll: z.boolean().optional()
    }),
    z.object({ kind: z.literal('semantic-workflow'), steps: z.array(atomicTaskGoal).min(1).max(20) })
  ]);

  const operationCondition = z.object({
    entityKey: z.string().min(1).max(512),
    factKey: z.string().min(1).max(128),
    expectedValueDigest: z.string().regex(/^[0-9a-f]{64}$/i)
  });
  const operationAssumption = z.object({
    key: z.string().min(1).max(128),
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/i)
  });
  const operationWorkItem = z.object({
    key: z.string().min(1).max(128),
    title: z.string().min(1).max(4096),
    role: z.enum(['supervisor', 'planner', 'coder', 'tester', 'browser', 'ui', 'verifier', 'general']),
    risk: z.enum(['read', 'write', 'external', 'system', 'destructive']).optional(),
    priority: z.number().int().min(-1000).max(1000).optional(),
    dependsOn: z.array(z.string().min(1).max(128)).max(1000).optional(),
    resources: z.array(z.string().min(1).max(1024)).max(5000).optional(),
    allowedCapabilities: z.array(z.string().min(1).max(256)).max(200).optional()
  });
  const operationTeamBudget = z.object({
    maxWorkers: z.number().int().min(1).max(64).optional(),
    maxConcurrentLeases: z.number().int().min(1).max(64).optional(),
    maxAttemptsPerWorkItem: z.number().int().min(1).max(10).optional(),
    maxWallClockMs: z.number().int().min(1000).max(24 * 60 * 60_000).optional(),
    leaseMs: z.number().int().min(1000).max(60 * 60_000).optional()
  });
  const operationExecution = z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('team'),
      workItems: z.array(operationWorkItem).min(1).max(1000),
      budget: operationTeamBudget.optional()
    }),
    z.object({
      kind: z.literal('organization'),
      targets: z.array(z.object({
        key: z.string().min(1).max(128),
        scopeKey: z.string().min(1).max(512),
        workItems: z.array(operationWorkItem).min(1).max(1000)
      })).min(1).max(5000),
      policy: z.object({
        canarySize: z.number().int().min(1).max(200).optional(),
        waveSize: z.number().int().min(1).max(200).optional(),
        maxParallel: z.number().int().min(1).max(200).optional(),
        allowedScopePrefixes: z.array(z.string().min(1).max(512)).min(1).max(100).optional(),
        teamBudget: operationTeamBudget.optional()
      }).optional()
    })
  ]);
  const operationProcedureStep = z.object({
    capability: z.string().min(1).max(256),
    risk: z.enum(['read', 'write', 'external', 'system', 'destructive']),
    summary: z.string().min(1).max(4096)
  });
  const operationSubmitSchema = z.object({
    operation: z.literal('submit'),
    requestId: taskUuid,
    objective: z.string().min(1).max(16_384),
    scopeKey: z.string().min(1).max(512),
    successConditions: z.array(z.string().min(1).max(4096)).min(1).max(100),
    preconditions: z.array(operationCondition).max(200).optional(),
    postconditions: z.array(operationCondition).max(200).optional(),
    execution: operationExecution.optional(),
    maxRisk: z.enum(['read', 'write', 'external', 'system', 'destructive']).default('read'),
    authority: z.object({
      capabilities: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/)).min(1).max(500),
      resources: z.array(z.string().min(1).max(1024)).min(1).max(5000)
    }).optional(),
    budget: operationTeamBudget.optional(),
    procedure: z.object({
      objectiveKind: z.string().min(1).max(128),
      assumptions: z.array(operationAssumption).max(100).default([]),
      requiredCapabilities: z.array(z.string().min(1).max(256)).max(200).optional()
    }).optional(),
    captureProcedure: z.object({
      key: z.string().min(1).max(256),
      title: z.string().min(1).max(4096),
      objectiveKind: z.string().min(1).max(256),
      assumptions: z.array(operationAssumption).max(100).default([]),
      steps: z.array(operationProcedureStep).min(1).max(200),
      resources: z.array(z.string().min(1).max(1024)).max(200).optional(),
      ttlMs: z.number().int().min(60_000).max(365 * 24 * 60 * 60_000).optional()
    }).optional(),
    strategies: z.array(z.object({
      id: z.string().min(1).max(256),
      staticScore: z.number().min(0).max(1)
    })).max(100).optional(),
    resourceRequirements: z.object({
      requiredTags: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)).max(64).optional(),
      minMemoryMb: z.number().int().min(0).max(1024 * 1024).optional(),
      requireGpu: z.boolean().optional(),
      slots: z.number().int().min(1).max(64).optional()
    }).optional(),
    run: z.boolean().default(true)
  });
  const operationsSchema = z.discriminatedUnion('operation', [
    operationSubmitSchema,
    z.object({ operation: z.enum(['inspect', 'start', 'refresh', 'pause', 'cancel']), operationId: taskUuid }),
    z.object({ operation: z.literal('promote'), operationId: taskUuid, verificationDigest: z.string().regex(/^[0-9a-f]{64}$/i) })
  ]);
  const knowledgeSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('procedures'), limit: z.number().int().min(1).max(500).default(100) }),
    z.object({
      kind: z.literal('procedure-query'),
      objectiveKind: z.string().min(1).max(128),
      scopeKey: z.string().min(1).max(512),
      assumptions: z.array(operationAssumption).max(100).default([]),
      requiredCapabilities: z.array(z.string().min(1).max(256)).max(200).default([]),
      maxResults: z.number().int().min(1).max(100).default(10)
    }),
    z.object({ kind: z.literal('world-entity'), entityKey: z.string().min(1).max(512) }),
    z.object({ kind: z.literal('world-fact'), entityKey: z.string().min(1).max(512), factKey: z.string().min(1).max(128) }),
    z.object({
      kind: z.literal('world-history'),
      entityKey: z.string().min(1).max(512),
      factKey: z.string().min(1).max(128).optional(),
      source: z.string().min(1).max(512).optional(),
      since: z.string().datetime().optional(),
      until: z.string().datetime().optional(),
      limit: z.number().int().min(1).max(1000).default(100)
    }),
    z.object({
      kind: z.literal('world-trace'),
      fromKey: z.string().min(1).max(512),
      toKey: z.string().min(1).max(512).optional(),
      targetType: z.string().min(1).max(128).optional(),
      maxDepth: z.number().int().min(1).max(12).optional(),
      minConfidence: z.number().min(0).max(1).optional()
    }).refine((value) => Boolean(value.toKey || value.targetType), 'world-trace requires toKey or targetType'),
    z.object({
      kind: z.literal('world-list'),
      scopeKey: z.string().min(1).max(512).optional(),
      type: z.string().min(1).max(128).optional(),
      limit: z.number().int().min(1).max(1000).default(100)
    }),
    z.object({ kind: z.literal('optimizer'), limit: z.number().int().min(1).max(1000).default(200) })
  ]);

  server.registerTool('task.submit', {
    title: 'Submit durable semantic task',
    description: 'Create one durable, UUID-addressed semantic task or bounded semantic workflow and optionally start it. The UUID makes submission retry-safe. Workflow children remain typed and every action still passes local capability, policy, approval, and postcondition checks; this tool cannot grant approval.',
    inputSchema: z.object({
      requestId: taskUuid, objective: z.string().min(1).max(16_384), successConditions: z.array(z.string().min(1).max(16_384)).min(1).max(1000),
      prohibitedScope: z.array(z.string().min(1).max(4096)).max(1000).optional(), goal: taskGoal,
      run: z.boolean().default(true), maxSteps: z.number().int().min(1).max(100).optional(), maxAttemptsPerStep: z.number().int().min(1).max(5).optional(), timeoutMs: z.number().int().min(100).max(60 * 60_000).optional()
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, async (input) => taskResultWithAgent(agent, await agent.submitTask(input as any), 'task.submit'));

  server.registerTool('task.control', {
    title: 'Control durable semantic task',
    description: 'Inspect, run, pause, resume, or cancel a durable task on its originally bound device. Resume never accepts an approval ID or recovery token; locally blocked actions remain blocked until approved through the separate local approval authority.',
    inputSchema: z.object({ taskId: taskUuid, operation: z.enum(['inspect', 'run', 'pause', 'resume', 'cancel']) }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async ({ taskId, operation }) => taskResultWithAgent(agent, await agent.controlTask(taskId, operation), 'task.control'));

  server.registerTool('operations', {
    title: 'Run governed digital operation',
    description: 'Submit or control a durable Stage-10 outcome contract. execution may be omitted only with an explicit authority envelope containing a requested capability subset and exact Stage-4 resource keys; the runtime intersects that subset with capabilities already authorized locally, so the envelope can restrict but never grant authority. maxRisk defaults to read, and dynamic-risk capabilities are excluded from auto-planning. Explicit work graphs remain supported. It composes verified memory, world postconditions, Stage-4 teams, Stage-8 rollouts, Stage-9 learning, and trusted Stage-7 placement; it cannot carry approval authority or raw device advertisements.',
    inputSchema: operationsSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, async (input) => {
    if (input.operation === 'submit') {
      const { operation: _operation, ...request } = input;
      return operationResultWithAgent(agent, await agent.submitOperation(request as any));
    }
    return operationResultWithAgent(
      agent,
      await agent.controlOperation(input.operationId, input.operation, input.operation === 'promote' ? input.verificationDigest : undefined)
    );
  });

  server.registerTool('knowledge.inspect', {
    title: 'Inspect verified agent knowledge',
    description: 'Read verified procedural memory, evidence-backed world-model entities/facts/relations/temporal history, or bounded aggregate execution-optimizer statistics. This tool is read-only and cannot promote procedures, publish world claims, widen authority, or alter policy.',
    inputSchema: knowledgeSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async (input) => knowledgeResultWithAgent(await agent.inspectKnowledge(input as any)));

  server.registerTool('computer.inspect', {
    title: 'Inspect computer',
    description: 'Inspect bounded native state of the authorized computer without reading unrelated files or secrets.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async () => invoke('computer.inspect', 'read', {}));

  server.registerTool('project.inspect', {
    title: 'Inspect project',
    description: 'Build a compact semantic model of an authorized project root from its manifests and repository metadata.',
    inputSchema: z.object({ path: z.string().min(1) }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ path }) => invoke('project.inspect', 'read', { path }, path));

  server.registerTool('project.command', {
    title: 'Inspect or run trusted project command',
    description: 'Inspect commands from the local Operator trusted-command registry, or run one through shell-free process execution. Repository manifests are observational only and cannot grant command authority. Run requires the caller to acknowledge the registry risk; that same risk is evaluated by the local policy engine before execution.',
    inputSchema: z.object({
      operation: z.enum(['inspect', 'run']),
      path: z.string().min(1),
      commandId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/).optional(),
      expectedRisk: z.enum(['read', 'write', 'external']).optional()
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async ({ operation, path, commandId, expectedRisk }) => {
    if (operation === 'inspect') return invoke('project.command.inspect', 'read', { path }, path);
    if (!commandId || !expectedRisk) {
      return {
        isError: true,
        content: [{ type: 'text' as const, text: 'project.command.run requires commandId and expectedRisk from a fresh project.command inspect.' }],
        structuredContent: {
          ok: false,
          capability: 'project.command.run',
          provider: 'mcp.validation',
          evidence: [],
          error: { code: 'PROJECT_COMMAND_INPUT_REQUIRED', message: 'commandId and expectedRisk are required.', retryable: false },
          durationMs: 0
        }
      };
    }
    return invoke('project.command.run', expectedRisk, { path, commandId, expectedRisk }, path);
  });

  server.registerTool('project.transaction', {
    title: 'Run approved trusted command with automatic Git rollback',
    description: 'Run a trusted local read/write project command inside a Git-scoped transaction. Operator creates a non-mutating checkpoint before execution, verifies command/artifact postconditions, and restores the checkpoint if verification fails. External commands are refused because their effects are not locally reversible. Rollback covers the Git index and non-ignored working-tree state captured by git.checkpoint, so this capability is always destructive-policy gated.',
    inputSchema: z.object({
      path: z.string().min(1),
      commandId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
      expectedRisk: z.enum(['read', 'write'])
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ path, commandId, expectedRisk }) => invoke('project.transaction.run', 'destructive', {
    path,
    commandId,
    expectedRisk
  }, path));

  server.registerTool('file.read', {
    title: 'Read project file',
    description: 'Read a bounded file inside an authorized root. The local agent rejects traversal and symlink escapes.',
    inputSchema: z.object({ path: z.string().min(1), encoding: z.enum(['utf8', 'base64']).default('utf8') }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ path, encoding }) => invoke('file.read', 'read', { path, encoding }, path));

  server.registerTool('file.list', {
    title: 'List project directory',
    description: 'List a bounded directory inside an authorized root.',
    inputSchema: z.object({ path: z.string().min(1) }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ path }) => invoke('file.list', 'read', { path }, path));

  server.registerTool('file.write', {
    title: 'Write project file',
    description: 'Atomically write a file inside an authorized root. Supply expectedSha256 after reading an existing file to prevent stale overwrites.',
    inputSchema: z.object({
      path: z.string().min(1),
      content: z.string(),
      expectedSha256: z.string().regex(/^[0-9a-f]{64}$/i).optional()
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ path, content, expectedSha256 }) => invoke('file.write', 'write', { path, content, expectedSha256 }, path));

  server.registerTool('file.info', {
    title: 'Inspect file or directory metadata',
    description: 'Inspect bounded metadata for a path inside an authorized root. Regular files include SHA-256 when within the local read bound.',
    inputSchema: z.object({ path: z.string().min(1) }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ path }) => invoke('file.info', 'read', { path }, path));

  server.registerTool('file.search', {
    title: 'Search authorized project files',
    description: 'Perform a bounded recursive filename search inside an authorized directory without following symlinks.',
    inputSchema: z.object({
      path: z.string().min(1),
      query: z.string().min(1).max(512),
      kind: z.enum(['all', 'file', 'directory']).default('all'),
      maxDepth: z.number().int().min(0).max(20).default(8),
      maxResults: z.number().int().min(1).max(1000).default(100)
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ path, query, kind, maxDepth, maxResults }) => invoke('file.search', 'read', { path, query, kind, maxDepth, maxResults }, path));

  server.registerTool('file.manage', {
    title: 'Manage authorized files and directories',
    description: 'Create directories, copy regular files without overwrite, SHA-guard move operations, or remove SHA-guarded files/empty directories. Move/remove remain destructive-policy gated.',
    inputSchema: z.object({
      operation: z.enum(['mkdir', 'copy', 'move', 'remove']),
      path: z.string().min(1).optional(),
      source: z.string().min(1).optional(),
      destination: z.string().min(1).optional(),
      recursive: z.boolean().default(false),
      expectedSha256: z.string().regex(/^[0-9a-f]{64}$/i).optional()
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ operation, path, source, destination, recursive, expectedSha256 }) => {
    const risk = operation === 'mkdir' || operation === 'copy' ? 'write' : 'destructive';
    return invoke('file.manage', risk, { operation, path, source, destination, recursive, expectedSha256 }, path ?? source);
  });

  server.registerTool('git.status', {
    title: 'Git status',
    description: 'Read repository status using the Git CLI directly rather than visual UI automation.',
    inputSchema: z.object({ cwd: z.string().min(1) }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ cwd }) => invoke('git.status', 'read', { cwd }, cwd));

  server.registerTool('git.diff', {
    title: 'Git diff',
    description: 'Read a bounded Git diff using Git directly, optionally scoped to paths.',
    inputSchema: z.object({ cwd: z.string().min(1), paths: z.array(z.string()).max(100).default([]) }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ cwd, paths }) => invoke('git.diff', 'read', { cwd, paths }, cwd));

  server.registerTool('git.checkpoint', {
    title: 'Checkpoint or restore Git worktree state',
    description: 'Create or inspect non-mutating Git checkpoints, or restore a checkpoint with a current-state fingerprint precondition. Checkpoints preserve separate index and working-tree trees, including ordinary untracked files. Restore refuses if HEAD moved, keeps an automatic recovery checkpoint, and is destructive-policy gated locally.',
    inputSchema: z.object({
      operation: z.enum(['create', 'inspect', 'restore']),
      cwd: z.string().min(1),
      label: z.string().max(160).optional(),
      checkpointId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/).optional(),
      expectedCurrentFingerprint: z.string().regex(/^[0-9a-f]{64}$/i).optional()
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ operation, cwd, label, checkpointId, expectedCurrentFingerprint }) => {
    if (operation === 'inspect') return invoke('git.checkpoint.inspect', 'read', { cwd }, cwd);
    if (operation === 'create') return invoke('git.checkpoint.create', 'write', { cwd, label }, cwd);
    if (!checkpointId || !expectedCurrentFingerprint) {
      return {
        isError: true,
        content: [{ type: 'text' as const, text: 'git.checkpoint.restore requires checkpointId and expectedCurrentFingerprint from a fresh inspect.' }],
        structuredContent: {
          ok: false,
          capability: 'git.checkpoint.restore',
          provider: 'mcp.validation',
          evidence: [],
          error: { code: 'CHECKPOINT_RESTORE_INPUT_REQUIRED', message: 'checkpointId and expectedCurrentFingerprint are required.', retryable: false },
          durationMs: 0
        }
      };
    }
    return invoke('git.checkpoint.restore', 'destructive', { cwd, checkpointId, expectedCurrentFingerprint }, cwd);
  });

  server.registerTool('git.write', {
    title: 'Apply structured Git write',
    description: 'Stage, unstage, or commit local repository changes through a closed Git operation set. Every operation requires a fresh repository fingerprint and creates a non-mutating recovery checkpoint first. Pathspec magic and escaping paths are rejected. Commits disable repository hooks and GPG signing and verify the resulting parent/tree.',
    inputSchema: z.object({
      operation: z.enum(['stage', 'unstage', 'commit']),
      cwd: z.string().min(1),
      paths: z.array(z.string().min(1).max(1000)).max(200).default([]),
      all: z.boolean().default(false),
      message: z.string().min(1).max(4000).optional(),
      expectedCurrentFingerprint: z.string().regex(/^[0-9a-f]{64}$/i)
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async ({ operation, cwd, paths, all, message, expectedCurrentFingerprint }) => invoke('git.write', 'write', {
    operation,
    cwd,
    paths,
    all,
    message,
    expectedCurrentFingerprint
  }, cwd));

  server.registerTool('docker.inspect', {
    title: 'Inspect local Docker state',
    description: 'Inspect the local Docker daemon or Compose-created containers associated with an authorized project root. Remote Docker contexts are rejected. Project inspection uses Docker-owned container labels and does not parse repository Compose YAML, environment files, commands, mounts, or arbitrary labels.',
    inputSchema: z.object({ path: z.string().min(1).optional() }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ path }) => invoke('docker.inspect', 'read', { path }, path));

  server.registerTool('docker.manage', {
    title: 'Manage existing local Compose service containers',
    description: 'Start, stop, or restart already-created Compose service containers matched to an authorized project root. Requires a fresh fingerprint from docker.inspect, rejects remote Docker contexts, never parses Compose YAML, and never exposes build/pull/run/exec/down/volume-delete operations. This is locally system-change gated.',
    inputSchema: z.object({
      path: z.string().min(1),
      operation: z.enum(['start', 'stop', 'restart']),
      services: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/)).min(1).max(50),
      expectedCurrentFingerprint: z.string().regex(/^[0-9a-f]{64}$/i),
      timeoutMs: z.number().int().min(1000).max(300000).default(60000)
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async ({ path, operation, services, expectedCurrentFingerprint, timeoutMs }) => invoke('docker.manage', 'system', {
    path,
    operation,
    services,
    expectedCurrentFingerprint,
    timeoutMs
  }, path));

  const postgresIdentifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_$]{0,62}$/);
  const postgresFilter = z.object({
    column: postgresIdentifier,
    op: z.enum(['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'like', 'ilike', 'is_null', 'not_null']),
    value: z.string().max(100000).optional()
  });
  const postgresOrder = z.object({ column: postgresIdentifier, direction: z.enum(['asc', 'desc']) });

  server.registerTool('postgres.query', {
    title: 'Inspect or query trusted local PostgreSQL profile',
    description: 'Inspect trusted PostgreSQL profiles or execute an Operator-constructed bounded read-only SELECT. Connection profiles live outside project roots and credentials are never returned to ChatGPT. Raw SQL, DSNs, passwords, DDL/DML, remote database hosts, and arbitrary psql arguments are not accepted.',
    inputSchema: z.object({
      operation: z.enum(['profiles', 'server', 'schemas', 'tables', 'columns', 'select']),
      path: z.string().min(1),
      profileId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/).optional(),
      schema: postgresIdentifier.default('public'),
      table: postgresIdentifier.optional(),
      columns: z.array(postgresIdentifier).max(50).default([]),
      filters: z.array(postgresFilter).max(20).default([]),
      orderBy: z.array(postgresOrder).max(10).default([]),
      limit: z.number().int().min(1).max(500).default(100),
      offset: z.number().int().min(0).max(10000).default(0),
      timeoutMs: z.number().int().min(100).max(30000).default(5000)
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ operation, path, profileId, schema, table, columns, filters, orderBy, limit, offset, timeoutMs }) => {
    if (operation === 'select') {
      if (!profileId || !table) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: 'postgres.query select requires profileId and table.' }],
          structuredContent: {
            ok: false,
            capability: 'postgres.select',
            provider: 'mcp.validation',
            evidence: [],
            error: { code: 'POSTGRES_SELECT_INPUT_REQUIRED', message: 'profileId and table are required.', retryable: false },
            durationMs: 0
          }
        };
      }
      return invoke('postgres.select', 'read', { path, profileId, schema, table, columns, filters, orderBy, limit, offset, timeoutMs }, path);
    }
    if (operation !== 'profiles' && !profileId) {
      return {
        isError: true,
        content: [{ type: 'text' as const, text: `postgres.query ${operation} requires profileId from a fresh profiles inspection.` }],
        structuredContent: {
          ok: false,
          capability: 'postgres.inspect',
          provider: 'mcp.validation',
          evidence: [],
          error: { code: 'POSTGRES_PROFILE_ID_REQUIRED', message: 'profileId is required.', retryable: false },
          durationMs: 0
        }
      };
    }
    if (operation === 'columns' && !table) {
      return {
        isError: true,
        content: [{ type: 'text' as const, text: 'postgres.query columns requires table.' }],
        structuredContent: {
          ok: false,
          capability: 'postgres.inspect',
          provider: 'mcp.validation',
          evidence: [],
          error: { code: 'POSTGRES_TABLE_REQUIRED', message: 'table is required.', retryable: false },
          durationMs: 0
        }
      };
    }
    return invoke('postgres.inspect', 'read', { path, operation, profileId, schema, table, timeoutMs }, path);
  });

  server.registerTool('vscode.inspect', {
    title: 'Inspect Visual Studio Code',
    description: 'Read bounded VS Code CLI version, process/status diagnostics, or installed extension identifiers/versions. This does not open a workspace and strips inherited VS Code IPC environment before invoking the CLI.',
    inputSchema: z.object({ operation: z.enum(['version', 'status', 'extensions']).default('status') }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ operation }) => invoke('vscode.inspect', 'read', { operation }));

  server.registerTool('vscode.open', {
    title: 'Open authorized target in isolated VS Code',
    description: 'Open an authorized folder/file, goto location, or two-file diff in a new Operator-isolated VS Code window with extensions disabled and a dedicated user-data directory outside project roots. The certified path never reuses an active user window and does not expose extension installation, VS Code chat, task/terminal execution, URL handling, or arbitrary CLI flags. This is locally system-change gated.',
    inputSchema: z.object({
      mode: z.enum(['folder', 'file', 'goto', 'diff']),
      path: z.string().min(1).optional(),
      leftPath: z.string().min(1).optional(),
      rightPath: z.string().min(1).optional(),
      line: z.number().int().min(1).max(1000000).optional(),
      column: z.number().int().min(1).max(1000000).optional(),
      timeoutMs: z.number().int().min(1000).max(60000).default(15000)
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async ({ mode, path, leftPath, rightPath, line, column, timeoutMs }) => {
    if ((mode === 'folder' || mode === 'file' || mode === 'goto') && !path) {
      return {
        isError: true,
        content: [{ type: 'text' as const, text: `vscode.open ${mode} requires path.` }],
        structuredContent: {
          ok: false,
          capability: 'vscode.open',
          provider: 'mcp.validation',
          evidence: [],
          error: { code: 'VSCODE_PATH_REQUIRED', message: 'path is required.', retryable: false },
          durationMs: 0
        }
      };
    }
    if (mode === 'goto' && line === undefined) {
      return {
        isError: true,
        content: [{ type: 'text' as const, text: 'vscode.open goto requires line.' }],
        structuredContent: {
          ok: false,
          capability: 'vscode.open',
          provider: 'mcp.validation',
          evidence: [],
          error: { code: 'VSCODE_LINE_REQUIRED', message: 'line is required.', retryable: false },
          durationMs: 0
        }
      };
    }
    if (mode === 'diff' && (!leftPath || !rightPath)) {
      return {
        isError: true,
        content: [{ type: 'text' as const, text: 'vscode.open diff requires leftPath and rightPath.' }],
        structuredContent: {
          ok: false,
          capability: 'vscode.open',
          provider: 'mcp.validation',
          evidence: [],
          error: { code: 'VSCODE_DIFF_PATHS_REQUIRED', message: 'leftPath and rightPath are required.', retryable: false },
          durationMs: 0
        }
      };
    }
    const target = mode === 'diff' ? leftPath : path;
    return invoke('vscode.open', 'system', { mode, path, leftPath, rightPath, line, column, timeoutMs }, target);
  });

  server.registerTool('terminal.execute', {
    title: 'Execute authorized process',
    description: 'Execute an allowlisted executable with an argv array and no command shell, inside an authorized root. This is a high-power development capability and is policy-gated locally.',
    inputSchema: z.object({
      executable: z.string().min(1),
      args: z.array(z.string()).max(200).default([]),
      cwd: z.string().min(1),
      timeoutMs: z.number().int().min(100).max(600000).default(30000)
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  }, async ({ executable, args, cwd, timeoutMs }) => invoke('terminal.execute', 'destructive', { executable, args, cwd, timeoutMs }, cwd));

  server.registerTool('terminal.session', {
    title: 'Manage interactive terminal session',
    description: 'Start an allowlisted shell-free process session, read bounded cursor-based output, write bounded stdin, list owned sessions, or terminate the owned process tree. Start/write/terminate remain destructive-policy gated.',
    inputSchema: z.object({
      operation: z.enum(['start', 'list', 'read', 'write', 'terminate']),
      executable: z.string().min(1).optional(),
      args: z.array(z.string()).max(200).default([]),
      cwd: z.string().min(1).optional(),
      sessionId: z.string().uuid().optional(),
      input: z.string().max(65536).optional(),
      afterCursor: z.number().int().min(0).optional(),
      maxEvents: z.number().int().min(1).max(500).default(100),
      maxBytes: z.number().int().min(1024).max(2097152).default(262144)
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  }, async ({ operation, executable, args, cwd, sessionId, input, afterCursor, maxEvents, maxBytes }) => {
    const risk = operation === 'list' || operation === 'read' ? 'read' : 'destructive';
    return invoke('terminal.session', risk, { operation, executable, args, cwd, sessionId, input, afterCursor, maxEvents, maxBytes }, cwd);
  });

  server.registerTool('process.inspect', {
    title: 'Inspect Windows process table',
    description: 'Read bounded Windows process metadata using tasklist. Returns image name, PID, session identity and memory usage only; command lines, environments and process memory are not exposed.',
    inputSchema: z.object({
      name: z.string().min(1).max(260).optional(),
      pid: z.number().int().positive().optional(),
      limit: z.number().int().min(1).max(500).default(200)
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ name, pid, limit }) => invoke('process.inspect', 'read', { name, pid, limit }));

  server.registerTool('process.manage', {
    title: 'Manage fingerprinted Windows process',
    description: 'Terminate one freshly inspected current-user Windows process tree. Requires the exact SHA-256 identity fingerprint from process.inspect, refuses Operator/system-critical/other-user processes, re-inspects the postcondition, and is destructive-policy gated.',
    inputSchema: z.object({
      operation: z.literal('terminate'),
      pid: z.number().int().positive(),
      expectedFingerprint: z.string().regex(/^[0-9a-f]{64}$/i)
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ operation, pid, expectedFingerprint }) => invoke('process.manage', 'destructive', { operation, pid, expectedFingerprint }, 'process:' + pid));

  server.registerTool('browser.inspect', {
    title: 'Inspect browser',
    description: 'Inspect compact Chromium tab state or a bounded semantic/accessibility snapshot of one target. Raw HTML and DevTools WebSocket URLs are not returned.',
    inputSchema: z.object({ targetId: z.string().min(1).optional() }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, async ({ targetId }) => invoke('browser.inspect', 'read', { targetId }));

  server.registerTool('browser.navigate', {
    title: 'Navigate browser',
    description: 'Navigate an existing Chromium target, or create a new tab, directly through CDP. Only HTTP(S) URLs without embedded credentials are accepted and the final destination is verified.',
    inputSchema: z.object({
      url: z.string().url(),
      targetId: z.string().min(1).optional(),
      newTab: z.boolean().default(false)
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  }, async ({ url, targetId, newTab }) => invoke('browser.navigate', 'write', { url, targetId, newTab }, targetId));

  server.registerTool('browser.interact', {
    title: 'Interact with browser control',
    description: 'Semantically click, hover, type, select, or set a bounded slider value on a browser control by CSS, text, or role+accessible name. Select accepts one value or a bounded list for native multi-select controls. This can cause external side effects, so the local policy treats it as an external action.',
    inputSchema: z.object({
      targetId: z.string().min(1),
      operation: z.enum(['click', 'hover', 'type', 'select', 'set_value']),
      target: z.object({
        css: z.string().min(1).max(500).optional(),
        text: z.string().min(1).max(500).optional(),
        role: z.string().min(1).max(100).optional(),
        name: z.string().min(1).max(500).optional()
      }),
      value: z.union([
        z.string().max(100000),
        z.array(z.string().max(100000)).min(1).max(100)
      ]).optional()
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  }, async ({ targetId, operation, target, value }) => invoke('browser.interact', 'external', { targetId, operation, target, value }, targetId));

  const appSelector = z.object({
    name: z.string().min(1).max(512).optional(),
    automationId: z.string().min(1).max(512).optional(),
    className: z.string().min(1).max(512).optional(),
    controlType: z.string().min(1).max(128).optional(),
    processId: z.number().int().positive().optional()
  }).refine((selector) => Object.values(selector).some((value) => value !== undefined), 'At least one semantic selector field is required.');

  const scrollAmount = z.enum(['large_decrement', 'small_decrement', 'none', 'large_increment', 'small_increment']);

  const perceptionBounds = z.object({
    x: z.number().min(-100000).max(100000),
    y: z.number().min(-100000).max(100000),
    width: z.number().positive().max(100000),
    height: z.number().positive().max(100000)
  });
  const perceptionTarget = z.object({
    semanticId: z.string().min(1).max(512).optional(),
    role: z.string().min(1).max(256).optional(),
    name: z.string().min(1).max(1024).optional(),
    text: z.string().min(1).max(4096).optional(),
    near: perceptionBounds.optional(),
    minConfidence: z.number().min(0).max(1).optional()
  }).refine((value) => Boolean(value.semanticId || value.role || value.name || value.text || value.near), 'Grounding requires at least one semantic or spatial selector.');
  const visualPerceptionObservation = z.object({
    semanticId: z.string().min(1).max(512).optional(),
    role: z.string().min(1).max(256).optional(),
    name: z.string().min(1).max(1024).optional(),
    text: z.string().min(1).max(4096).optional(),
    bounds: perceptionBounds,
    confidence: z.number().min(0).max(1).default(0.8)
  });

  server.registerTool('app.inspect', {
    title: 'Inspect Windows application',
    description: 'Inspect Windows semantically through UI Automation/Win32 discovery, request a bounded visual capture, or ground semantic/visual observations through the Stage-11 perception graph. Visual captures return a short-lived captureId + SHA-256 lease. Ground mode may persist only bounded model observations tied to that exact capture digest; those observations never grant authority, and any later physical input still requires the fresh one-shot capture lease.',
    inputSchema: z.object({
      mode: z.enum(['semantic', 'visual', 'ground']).default('semantic'),
      selector: appSelector.optional(),
      maxNodes: z.number().int().min(1).max(1500).default(250),
      maxDepth: z.number().int().min(1).max(12).default(6),
      observeMs: z.number().int().min(0).max(5000).default(0),
      waitMs: z.number().int().min(0).max(10000).default(0),
      includeWindows: z.boolean().default(false),
      maxWindows: z.number().int().min(1).max(200).default(50),
      source: z.enum(['screen', 'window', 'region']).default('screen'),
      region: z.object({
        x: z.number().int().min(-100000).max(100000),
        y: z.number().int().min(-100000).max(100000),
        width: z.number().int().min(1).max(16384),
        height: z.number().int().min(1).max(16384)
      }).optional(),
      maxWidth: z.number().int().min(1).max(1280).default(960),
      maxHeight: z.number().int().min(1).max(720).default(540),
      sceneKey: z.string().min(1).max(1024).optional(),
      captureId: z.string().min(1).max(128).optional(),
      expectedSha256: z.string().regex(/^[0-9a-fA-F]{64}$/).optional(),
      observations: z.array(visualPerceptionObservation).max(100).optional(),
      ground: perceptionTarget.optional()
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ mode, selector, maxNodes, maxDepth, observeMs, waitMs, includeWindows, maxWindows, source, region, maxWidth, maxHeight, sceneKey, captureId, expectedSha256, observations, ground }) => {
    if (mode === 'visual') {
      return attachActionImage(await invoke('visual.capture', 'read', { source, selector, region, maxWidth, maxHeight, waitMs }), ['output', 'imageBase64']);
    }
    if (mode === 'ground') {
      const resolvedSceneKey = sceneKey ?? (captureId ? `capture:${captureId}` : undefined);
      if (!resolvedSceneKey || !ground) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: 'Ground mode requires sceneKey (or captureId) and a ground selector.' }],
          structuredContent: {
            ok: false, capability: 'perception.ground', provider: 'mcp.validation', evidence: [],
            error: { code: 'PERCEPTION_GROUND_INPUT_REQUIRED', message: 'sceneKey/captureId and ground are required.', retryable: false }, durationMs: 0
          }
        };
      }
      if (observations?.length) {
        if (!captureId || !expectedSha256) {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: 'Visual observations require captureId and expectedSha256 from the exact app.inspect visual capture.' }],
            structuredContent: {
              ok: false, capability: 'perception.observe', provider: 'mcp.validation', evidence: [],
              error: { code: 'PERCEPTION_CAPTURE_BINDING_REQUIRED', message: 'captureId and expectedSha256 are required for visual observations.', retryable: false }, durationMs: 0
            }
          };
        }
        const normalized = observations.map((observation) => ({
          sceneKey: `capture:${captureId}`,
          channel: 'visual',
          source: 'chatgpt.visual',
          ...(observation.semanticId ? { semanticId: observation.semanticId } : {}),
          ...(observation.role ? { role: observation.role } : {}),
          ...(observation.name ? { name: observation.name } : {}),
          ...(observation.text ? { text: observation.text } : {}),
          bounds: observation.bounds,
          state: { captureId, captureSha256: expectedSha256.toLowerCase() },
          confidence: observation.confidence,
          ttlMs: 90_000,
          evidenceDigest: crypto.createHash('sha256').update(JSON.stringify({
            captureId,
            expectedSha256: expectedSha256.toLowerCase(),
            observation
          })).digest('hex')
        }));
        const stored = await invoke('perception.observe', 'write', { observations: normalized }, resolvedSceneKey);
        if (stored.isError) return stored;
      }
      return invoke('perception.ground', 'read', { sceneKey: resolvedSceneKey, ...ground }, resolvedSceneKey);
    }
    return invoke('app.inspect', 'read', { selector, maxNodes, maxDepth, observeMs, waitMs, includeWindows, maxWindows });
  });

  const semanticAppOperations = new Set(['invoke', 'set_value', 'focus', 'select', 'expand', 'collapse', 'scroll', 'activate_window']);
  const physicalAppOperations = new Set(['move', 'click', 'double_click', 'drag', 'physical_scroll', 'type_text', 'key_press', 'hotkey']);

  server.registerTool('app.operate', {
    title: 'Operate Windows application',
    description: 'Operate a Windows control semantically when UI Automation can identify it, or use a capture-bound physical fallback after app.inspect visual mode. Physical input requires the exact fresh captureId and SHA-256, consumes the lease once, checks window/foreground identity for keyboard input, and performs a fresh AFTER capture for post-action verification. This remains approval-gated as an external action.',
    inputSchema: z.object({
      operation: z.enum(['invoke', 'set_value', 'focus', 'select', 'expand', 'collapse', 'scroll', 'activate_window', 'move', 'click', 'double_click', 'drag', 'physical_scroll', 'type_text', 'key_press', 'hotkey']),
      selector: appSelector.optional(),
      value: z.string().max(65536).optional(),
      horizontalAmount: scrollAmount.optional(),
      verticalAmount: scrollAmount.optional(),
      waitMs: z.number().int().min(0).max(10000).default(0),
      captureId: z.string().min(1).max(128).optional(),
      expectedSha256: z.string().regex(/^[0-9a-fA-F]{64}$/).optional(),
      x: z.number().int().min(0).max(1279).optional(),
      y: z.number().int().min(0).max(719).optional(),
      toX: z.number().int().min(0).max(1279).optional(),
      toY: z.number().int().min(0).max(719).optional(),
      deltaX: z.number().int().min(-1200).max(1200).optional(),
      deltaY: z.number().int().min(-1200).max(1200).optional(),
      text: z.string().max(4096).optional(),
      key: z.string().min(1).max(32).optional(),
      keys: z.array(z.string().min(1).max(32)).min(1).max(4).optional()
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async ({ operation, selector, value, horizontalAmount, verticalAmount, waitMs, captureId, expectedSha256, x, y, toX, toY, deltaX, deltaY, text, key, keys }) => {
    if (physicalAppOperations.has(operation)) {
      const physicalOperation = operation === 'physical_scroll' ? 'scroll' : operation;
      return attachActionImage(await invoke('input.operate', 'external', {
        operation: physicalOperation, captureId, expectedSha256, x, y, toX, toY, deltaX, deltaY, text, key, keys
      }), ['output', 'after', 'imageBase64']);
    }
    if (!semanticAppOperations.has(operation) || !selector) {
      return {
        isError: true,
        content: [{ type: 'text' as const, text: 'Semantic app operations require a unique semantic selector.' }],
        structuredContent: {
          ok: false, capability: 'app.operate', provider: 'mcp.validation', evidence: [],
          error: { code: 'APP_SELECTOR_REQUIRED', message: 'Semantic app operations require selector.', retryable: false }, durationMs: 0
        }
      };
    }
    return invoke('app.operate', 'external', { operation, selector, value, horizontalAmount, verticalAmount, waitMs });
  });

  return server;
}

function attachActionImage<T extends { content: Array<Record<string, unknown>>; structuredContent?: unknown }>(
  result: T,
  path: string[]
): T {
  const root = result.structuredContent;
  if (!root || typeof root !== 'object' || Array.isArray(root)) return result;
  let cursor: Record<string, unknown> = root as Record<string, unknown>;
  for (const segment of path.slice(0, -1)) {
    const next = cursor[segment];
    if (!next || typeof next !== 'object' || Array.isArray(next)) return result;
    cursor = next as Record<string, unknown>;
  }
  const key = path.at(-1);
  if (!key) return result;
  const data = cursor[key];
  if (typeof data !== 'string' || data.length < 8 || data.length > 12 * 1024 * 1024) return result;
  const mimeValue = cursor.mimeType;
  const mimeType = typeof mimeValue === 'string' && /^image\/(?:png|jpeg|webp)$/.test(mimeValue) ? mimeValue : 'image/png';
  delete cursor[key];
  result.content.push({ type: 'image', data, mimeType });
  return result;
}

function operationResultWithAgent(
  _agent: LocalAgentClient,
  result: Awaited<ReturnType<LocalAgentClient['submitOperation']>>
) {
  const operation = result.operation as Record<string, unknown> | undefined;
  const summary = result.ok
    ? `operations: ${String(operation?.state ?? 'PENDING')} operation ${String(operation?.id ?? '')}`.trim()
    : `operations: NOT VERIFIED (${result.error?.code ?? 'UNKNOWN'}) ${result.error?.message ?? ''}`;
  return {
    isError: !result.ok,
    content: [{ type: 'text' as const, text: summary }],
    structuredContent: result
  };
}

function knowledgeResultWithAgent(result: Awaited<ReturnType<LocalAgentClient['inspectKnowledge']>>) {
  const error = result.error as { code?: string; message?: string } | undefined;
  const summary = result.ok ? 'knowledge.inspect: VERIFIED read' : `knowledge.inspect: failed (${error?.code ?? 'UNKNOWN'}) ${error?.message ?? ''}`;
  return {
    isError: !result.ok,
    content: [{ type: 'text' as const, text: summary }],
    structuredContent: result
  };
}

function taskResultWithAgent(
  _agent: LocalAgentClient,
  result: Awaited<ReturnType<LocalAgentClient['submitTask']>>,
  capability: 'task.submit' | 'task.control'
) {
  const task = result.task as Record<string, unknown> | undefined;
  const summary = result.ok
    ? `${capability}: ${String(task?.state ?? 'PENDING')} task ${String(task?.id ?? '')}`.trim()
    : `${capability}: NOT VERIFIED (${result.error?.code ?? 'UNKNOWN'}) ${result.error?.message ?? ''}`;
  return {
    isError: !result.ok,
    content: [{ type: 'text' as const, text: summary }],
    structuredContent: result
  };
}

async function invokeWithAgent(agent: LocalAgentClient, capability: string, risk: ActionRisk, input: Record<string, unknown>, target?: string) {
  const action: ActionRequest = {
    id: stableActionId(capability, risk, input, target),
    capability,
    risk,
    input,
    provenance: { kind: 'chatgpt' },
    target
  };
  const result = await agent.execute(action);
  const summary = result.ok
    ? `${capability}: VERIFIED via ${result.provider} in ${result.durationMs}ms`
    : `${capability}: NOT VERIFIED (${result.error?.code ?? 'UNKNOWN'}) ${result.error?.message ?? ''}`;
  return {
    isError: !result.ok,
    content: [{ type: 'text' as const, text: summary }],
    structuredContent: result
  };
}
