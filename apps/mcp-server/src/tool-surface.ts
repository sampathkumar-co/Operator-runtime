export type ToolSurfaceRisk = 'read' | 'write' | 'external' | 'system' | 'destructive' | 'dynamic';

export const TOOL_SURFACE: ReadonlyArray<{ name: string; risk: ToolSurfaceRisk; description: string }> = [
  { name: 'computer.inspect', risk: 'read', description: 'Inspect bounded native state of an authorized computer.' },
  { name: 'project.inspect', risk: 'read', description: 'Inspect semantic metadata for an authorized project root.' },
  { name: 'project.command', risk: 'dynamic', description: 'Inspect or run a trusted project command; run risk is read, write, or external from the trusted registry.' },
  { name: 'project.transaction', risk: 'destructive', description: 'Run an approved trusted command inside a Git-scoped rollback transaction.' },
  { name: 'file.read', risk: 'read', description: 'Read a bounded file inside an authorized root.' },
  { name: 'file.list', risk: 'read', description: 'List a bounded directory inside an authorized root.' },
  { name: 'file.write', risk: 'write', description: 'Atomically write a file inside an authorized root, optionally guarded by expected SHA-256.' },
  { name: 'git.status', risk: 'read', description: 'Read structured repository status using Git directly.' },
  { name: 'git.diff', risk: 'read', description: 'Read a bounded Git diff using Git directly.' },
  { name: 'git.checkpoint', risk: 'destructive', description: 'Create, inspect, or restore a Git checkpoint; restore is destructive-policy gated.' },
  { name: 'git.write', risk: 'write', description: 'Stage, unstage, or commit through closed Git operations with recovery checkpoints.' },
  { name: 'docker.inspect', risk: 'read', description: 'Inspect bounded local Docker or Compose-created container state.' },
  { name: 'docker.manage', risk: 'system', description: 'Start, stop, or restart existing authorized local Compose service containers.' },
  { name: 'postgres.query', risk: 'read', description: 'Inspect trusted local PostgreSQL profiles or execute bounded read-only structured SELECTs.' },
  { name: 'vscode.inspect', risk: 'read', description: 'Read bounded Visual Studio Code CLI state.' },
  { name: 'vscode.open', risk: 'system', description: 'Open an authorized target in an isolated VS Code window with extensions disabled.' },
  { name: 'terminal.execute', risk: 'destructive', description: 'Execute an allowlisted executable with argv and no command shell under destructive local policy.' },
  { name: 'browser.inspect', risk: 'read', description: 'Inspect Chromium tabs or a bounded semantic page snapshot through loopback CDP.' },
  { name: 'browser.navigate', risk: 'read', description: 'Navigate a Chromium tab through CDP and verify the resulting destination.' },
  { name: 'browser.interact', risk: 'external', description: 'Semantically interact with a browser control and verify element/page state.' },
  { name: 'app.inspect', risk: 'read', description: 'Inspect bounded Windows UI Automation state.' },
  { name: 'app.operate', risk: 'external', description: 'Operate a Windows control through a closed semantic UI Automation operation set.' }
] as const;

export const TOOL_NAMES = Object.freeze(TOOL_SURFACE.map((tool) => tool.name).sort());