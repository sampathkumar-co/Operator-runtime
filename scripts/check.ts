import fs from 'node:fs/promises';
import path from 'node:path';
import '../src/core/index.ts';
import '../src/capabilities/index.ts';
import '../apps/local-agent/src/runtime-factory.ts';
import '../apps/local-agent/src/server.ts';
import { TOOL_SURFACE } from '../apps/mcp-server/src/tool-surface.ts';

if (new Set(TOOL_SURFACE.map((tool) => tool.name)).size !== TOOL_SURFACE.length) {
  throw new Error('Duplicate external tool names detected.');
}

await verifyWorkflowSupplyChain();
console.log(`syntax/import check passed; ${TOOL_SURFACE.length} external tools defined; workflow dependencies pinned`);

async function verifyWorkflowSupplyChain(): Promise<void> {
  const workflowDir = path.join(process.cwd(), '.github', 'workflows');
  const names = (await fs.readdir(workflowDir)).filter((name) => /\.ya?ml$/i.test(name)).sort();
  const unpinned: string[] = [];
  const floatingRust: string[] = [];

  for (const name of names) {
    const text = await fs.readFile(path.join(workflowDir, name), 'utf8');
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      const use = line.match(/^\s*-?\s*uses:\s*([^\s#]+)/);
      if (use) {
        const spec = use[1]!;
        // Local actions are part of this repository. Every remote GitHub Action must be immutable.
        if (!spec.startsWith('./')) {
          const at = spec.lastIndexOf('@');
          const ref = at >= 0 ? spec.slice(at + 1) : '';
          if (!/^[0-9a-f]{40}$/i.test(ref)) unpinned.push(`${name}:${index + 1}:${spec}`);
        }
      }
      if (/\brustup\s+default\s+(?:stable|beta|nightly)\b/.test(line)) {
        floatingRust.push(`${name}:${index + 1}:${line.trim()}`);
      }
    }
  }

  if (unpinned.length > 0) {
    throw new Error(`Remote GitHub Actions must be pinned to immutable 40-hex SHAs:\n${unpinned.join('\n')}`);
  }
  if (floatingRust.length > 0) {
    throw new Error(`Release/test workflows must pin an explicit Rust toolchain version:\n${floatingRust.join('\n')}`);
  }
}
