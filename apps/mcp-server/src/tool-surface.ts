import { CAPABILITY_RISK_RULES } from '../../../src/core/capability-policy.ts';

export type ToolSurfaceRisk = 'read' | 'write' | 'external' | 'system' | 'destructive' | 'dynamic';

export const TOOL_SURFACE: ReadonlyArray<{ name: string; risk: ToolSurfaceRisk; description: string }> = [
  { name: 'task.submit', risk: 'dynamic', description: 'Submit an idempotent durable semantic task that remains subject to local policy and approval.' },
  { name: 'task.control', risk: 'dynamic', description: 'Inspect, run, pause, resume, or cancel a durable semantic task without remote approval authority.' },
  { name: 'operations', risk: 'dynamic', description: 'Submit or control a durable outcome-governed Stage-10 operation across verified memory, world state, teams, organization rollouts and trusted device placement.' },
  { name: 'knowledge.inspect', risk: 'read', description: 'Read verified procedural memory, evidence-backed world-model state, and bounded execution-optimizer statistics.' },
  { name: 'computer.inspect', risk: 'read', description: 'Inspect bounded native state of an authorized computer.' },
  { name: 'project.inspect', risk: 'read', description: 'Inspect semantic metadata for an authorized project root.' },
  { name: 'project.command', risk: 'dynamic', description: 'Inspect or run a trusted project command; run risk is read, write, or external from the trusted registry.' },
  { name: 'project.transaction', risk: 'destructive', description: 'Run an approved trusted command inside a Git-scoped rollback transaction.' },
  { name: 'workspace.edit', risk: 'write', description: 'Apply durable transactional or trusted-verification-gated multi-file workspace edits.' },
  { name: 'file.read', risk: 'read', description: 'Read a bounded file inside an authorized root.' },
  { name: 'file.list', risk: 'read', description: 'List a bounded directory inside an authorized root.' },
  { name: 'file.write', risk: 'dynamic', description: 'Write, create-only, or SHA-guard replace a file inside an authorized root with mode-specific canonical risk.' },
  { name: 'file.info', risk: 'read', description: 'Inspect bounded path metadata and SHA-256 inside an authorized root.' },
  { name: 'file.search', risk: 'read', description: 'Search filenames recursively inside authorized roots without following symlinks.' },
  { name: 'file.manage', risk: 'dynamic', description: 'Create directories, copy, move, or remove authorized paths with operation-specific risk and preconditions.' },
  { name: 'git.status', risk: 'read', description: 'Inspect structured Git status or resolve the canonical repository root.' },
  { name: 'git.diff', risk: 'read', description: 'Read a bounded Git diff using Git directly.' },
  { name: 'git.checkpoint', risk: 'destructive', description: 'Create, inspect, or restore a Git checkpoint; restore is destructive-policy gated.' },
  { name: 'git.write', risk: 'write', description: 'Stage, unstage, or commit through closed Git operations with recovery checkpoints.' },
  { name: 'docker.inspect', risk: 'read', description: 'Inspect bounded local Docker or Compose-created container state.' },
  { name: 'docker.manage', risk: 'system', description: 'Start, stop, or restart existing authorized local Compose service containers.' },
  { name: 'compute.run', risk: 'write', description: 'Execute bounded JavaScript or Python inside a no-network, read-only, no-host-mount Docker sandbox.' },
  { name: 'postgres.query', risk: 'read', description: 'Inspect trusted local PostgreSQL profiles or execute bounded read-only structured SELECTs.' },
  { name: 'vscode.inspect', risk: 'read', description: 'Read bounded Visual Studio Code CLI state.' },
  { name: 'vscode.open', risk: 'system', description: 'Open an authorized target in an isolated VS Code window with extensions disabled.' },
  { name: 'terminal.execute', risk: 'destructive', description: 'Execute an allowlisted executable with argv and no command shell under destructive local policy.' },
  { name: 'terminal.session', risk: 'dynamic', description: 'Manage bounded interactive sessions for owned allowlisted processes.' },
  { name: 'process.inspect', risk: 'read', description: 'Inspect bounded Windows process-table metadata without command lines or environments.' },
  { name: 'process.manage', risk: 'destructive', description: 'Terminate one freshly fingerprinted current-user Windows process tree under destructive approval.' },
  { name: 'browser.inspect', risk: 'read', description: 'Inspect Chromium tabs or a bounded semantic page snapshot through loopback CDP.' },
  { name: 'browser.verify', risk: 'read', description: 'Independently verify bounded visible browser postconditions without mutating page state.' },
  { name: 'browser.navigate', risk: 'write', description: 'Navigate a Chromium tab through CDP and verify the resulting destination.' },
  { name: 'browser.interact', risk: 'dynamic', description: 'Interact with observed browser controls or focus/close exact observed tabs with mode-specific canonical risk.' },
  { name: 'app.inspect', risk: 'dynamic', description: 'Inspect UI Automation state, capture bounded visuals, publish capture-bound observations, or ground fused perception.' },
  { name: 'app.operate', risk: 'external', description: 'Operate a semantic Windows control or capture-bound physical input through the shared runtime.' }
] as const;

export const TOOL_NAMES = Object.freeze(TOOL_SURFACE.map((tool) => tool.name).sort());

export const CAPABILITY_TOOL_ROUTES = Object.freeze<Record<string, string>>({
  'computer.inspect': 'computer.inspect',
  'project.inspect': 'project.inspect',
  'project.command.inspect': 'project.command',
  'project.command.run': 'project.command',
  'project.transaction.run': 'project.transaction',
  'workspace.edit.transaction': 'workspace.edit',
  'workspace.edit.verified': 'workspace.edit',
  'file.read': 'file.read',
  'file.list': 'file.list',
  'file.write': 'file.write',
  'file.create': 'file.write',
  'file.replace': 'file.write',
  'file.info': 'file.info',
  'file.search': 'file.search',
  'file.manage': 'file.manage',
  'git.status': 'git.status',
  'git.diff': 'git.diff',
  'git.rev-parse': 'git.status',
  'git.checkpoint.inspect': 'git.checkpoint',
  'git.checkpoint.create': 'git.checkpoint',
  'git.checkpoint.restore': 'git.checkpoint',
  'git.write': 'git.write',
  'docker.inspect': 'docker.inspect',
  'docker.manage': 'docker.manage',
  'compute.run': 'compute.run',
  'postgres.inspect': 'postgres.query',
  'postgres.select': 'postgres.query',
  'vscode.inspect': 'vscode.inspect',
  'vscode.open': 'vscode.open',
  'terminal.execute': 'terminal.execute',
  'terminal.session': 'terminal.session',
  'process.inspect': 'process.inspect',
  'process.manage': 'process.manage',
  'browser.inspect': 'browser.inspect',
  'browser.verify': 'browser.verify',
  'browser.navigate': 'browser.navigate',
  'browser.interact': 'browser.interact',
  'browser.tab.focus': 'browser.interact',
  'browser.tab.close': 'browser.interact',
  'app.inspect': 'app.inspect',
  'app.operate': 'app.operate',
  'visual.capture': 'app.inspect',
  'input.operate': 'app.operate',
  'perception.observe': 'app.inspect',
  'perception.ground': 'app.inspect'
});

assertDeveloperCapabilityParity();

function assertDeveloperCapabilityParity(): void {
  const canonical = Object.keys(CAPABILITY_RISK_RULES).sort();
  const routed = Object.keys(CAPABILITY_TOOL_ROUTES).sort();
  if (canonical.length !== routed.length || canonical.some((capability, index) => capability !== routed[index])) {
    const missing = canonical.filter((capability) => !CAPABILITY_TOOL_ROUTES[capability]);
    const stale = routed.filter((capability) => !(capability in CAPABILITY_RISK_RULES));
    throw new Error(`Developer MCP capability parity drift: missing=[${missing.join(',')}] stale=[${stale.join(',')}]`);
  }
  const declaredTools = new Set(TOOL_NAMES);
  for (const [capability, tool] of Object.entries(CAPABILITY_TOOL_ROUTES)) {
    if (!declaredTools.has(tool)) {
      throw new Error(`Developer MCP capability ${capability} routes to undeclared tool ${tool}.`);
    }
  }
}
