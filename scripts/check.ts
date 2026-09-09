import '../src/core/index.ts';
import '../src/capabilities/index.ts';
import '../apps/local-agent/src/runtime-factory.ts';
import '../apps/local-agent/src/server.ts';
import { TOOL_SURFACE } from '../apps/mcp-server/src/tool-surface.ts';

if (new Set(TOOL_SURFACE.map((tool) => tool.name)).size !== TOOL_SURFACE.length) {
  throw new Error('Duplicate external tool names detected.');
}
console.log(`syntax/import check passed; ${TOOL_SURFACE.length} external tools defined`);
