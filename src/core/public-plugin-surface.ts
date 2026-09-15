// Dependency-free contract shared by root publication tests and the MCP adapter.
// Keep this list limited to tools that are intentionally exposed by the public plugin.
export const PUBLIC_PLUGIN_TOOL_NAMES = Object.freeze([
  'device.claim',
  'computer.inspect',
  'project.inspect',
  'project.commands',
  'file.list',
  'file.read',
  'file.create',
  'file.replace',
  'git.status',
  'git.diff'
].sort());
export const PUBLIC_PLUGIN_CAPABILITIES = Object.freeze([
  'computer.inspect',
  'project.inspect',
  'project.command.inspect',
  'file.list',
  'file.read',
  'file.create',
  'file.replace',
  'git.status',
  'git.diff'
].sort());
