import crypto from 'node:crypto';
import { createMcpFastifyApp } from '@modelcontextprotocol/fastify';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { LocalAgentClient } from './local-agent-client.ts';
import type { ActionRequest, ActionRisk } from '../../../src/core/types.ts';

const agentUrl = process.env.OPERATOR_AGENT_URL ?? 'http://127.0.0.1:47100';
const agentToken = process.env.OPERATOR_AGENT_TOKEN;
if (!agentToken || agentToken.length < 32) {
  throw new Error('OPERATOR_AGENT_TOKEN must be set and match the local agent token.');
}
const agent = new LocalAgentClient(agentUrl, agentToken);

const handler = createMcpHandler(() => createServer());
const nodeHandler = toNodeHandler(handler);
const app = createMcpFastifyApp();
app.all('/mcp', (request, reply) => nodeHandler(request.raw, reply.raw, request.body));
app.get('/health', async () => ({ ok: true, service: 'operator-mcp-server', version: '0.1.0' }));

const port = Number(process.env.OPERATOR_MCP_PORT ?? 47200);
const host = process.env.OPERATOR_MCP_HOST ?? '127.0.0.1';
await app.listen({ host, port });
console.error(`[operator] MCP server listening on http://${host}:${port}/mcp`);

function createServer(): McpServer {
  const server = new McpServer(
    { name: 'Operator', title: 'Operator', version: '0.1.0' },
    { capabilities: { tools: {} }, instructions: 'Operate only user-authorized computers. Prefer semantic/native capabilities and return evidence-rich results.' }
  );

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
  }, async ({ executable, args, cwd, timeoutMs }) => invoke('terminal.execute', 'write', { executable, args, cwd, timeoutMs }, cwd));

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
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  }, async ({ url, targetId, newTab }) => invoke('browser.navigate', 'read', { url, targetId, newTab }, targetId));

  server.registerTool('browser.interact', {
    title: 'Interact with browser control',
    description: 'Semantically click, type, or select a browser control by CSS, text, or role+accessible name. This can cause external side effects, so the local policy treats it as an external action.',
    inputSchema: z.object({
      targetId: z.string().min(1),
      operation: z.enum(['click', 'type', 'select']),
      target: z.object({
        css: z.string().min(1).max(500).optional(),
        text: z.string().min(1).max(500).optional(),
        role: z.string().min(1).max(100).optional(),
        name: z.string().min(1).max(500).optional()
      }),
      value: z.string().max(100000).optional()
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

  server.registerTool('app.inspect', {
    title: 'Inspect Windows application controls',
    description: 'Wait up to 10 seconds for a unique semantic selector, inspect a bounded Microsoft UI Automation control tree, optionally observe selector-scoped property/structure changes for up to 5 seconds, and optionally include up to 200 top-level Win32 windows with PID, executable basename, title/class and foreground state. No screenshots, process memory, command lines, or full executable paths are returned.',
    inputSchema: z.object({
      selector: appSelector.optional(),
      maxNodes: z.number().int().min(1).max(1500).default(250),
      maxDepth: z.number().int().min(1).max(12).default(6),
      observeMs: z.number().int().min(0).max(5000).default(0),
      waitMs: z.number().int().min(0).max(10000).default(0),
      includeWindows: z.boolean().default(false),
      maxWindows: z.number().int().min(1).max(200).default(50)
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ selector, maxNodes, maxDepth, observeMs, waitMs, includeWindows, maxWindows }) => invoke('app.inspect', 'read', {
    selector,
    maxNodes,
    maxDepth,
    observeMs,
    waitMs,
    includeWindows,
    maxWindows
  }));

  server.registerTool('app.operate', {
    title: 'Operate Windows application control',
    description: 'Wait up to 10 seconds for one uniquely matched Windows control, then operate it through Microsoft UI Automation Invoke, Value, Focus, SelectionItem, ExpandCollapse, bounded Scroll, or verified semantic window activation. Window activation never accepts a raw HWND; it resolves the selector first and verifies the resulting foreground window. Ambiguous selectors fail immediately. This action may cause external side effects and remains approval-gated locally.',
    inputSchema: z.object({
      operation: z.enum(['invoke', 'set_value', 'focus', 'select', 'expand', 'collapse', 'scroll', 'activate_window']),
      selector: appSelector,
      value: z.string().max(65536).optional(),
      horizontalAmount: scrollAmount.optional(),
      verticalAmount: scrollAmount.optional(),
      waitMs: z.number().int().min(0).max(10000).default(0)
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async ({ operation, selector, value, horizontalAmount, verticalAmount, waitMs }) => invoke('app.operate', 'external', {
    operation,
    selector,
    value,
    horizontalAmount,
    verticalAmount,
    waitMs
  }));

  return server;
}

async function invoke(capability: string, risk: ActionRisk, input: Record<string, unknown>, target?: string) {
  const action: ActionRequest = {
    id: crypto.randomUUID(),
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
