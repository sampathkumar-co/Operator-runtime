import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ActionRequest, ActionResult, CapabilityProvider, CapabilityScore } from '../core/types.ts';
import { OperatorError } from '../core/errors.ts';
import { evidence } from '../core/evidence.ts';
import { PathScope } from './path-scope.ts';

const SCORE: CapabilityScore = {
  reliability: 0.97,
  latency: 0.96,
  determinism: 0.98,
  security: 0.96,
  reversibility: 1,
  informationQuality: 0.94,
  interactionCost: 0.01
};

export class ProjectInspectProvider implements CapabilityProvider {
  readonly name = 'project.semantic';
  #scope: PathScope;

  constructor(options: { allowedRoots: string[]; windowsPathLeaseExecutable?: string }) {
    this.#scope = new PathScope(options.allowedRoots, {
      ...(options.windowsPathLeaseExecutable ? { windowsPathLeaseExecutable: options.windowsPathLeaseExecutable } : {})
    });
  }
  supports(action: ActionRequest): boolean { return action.capability === 'project.inspect'; }
  score(): CapabilityScore { return SCORE; }

  async execute(action: ActionRequest): Promise<ActionResult> {
    const started = performance.now();
    const root = await this.#scope.resolveExisting(String(action.input.path ?? ''));
    const names = await fs.readdir(root);
    const has = (name: string) => names.includes(name);
    // Resolve each manifest independently under the approved scope. Merely
    // validating the project directory cannot authorize symlinked children.
    const packageText = await maybeScopedText(this.#scope, path.join(root, 'package.json'), 4 * 1024 * 1024);
    const packageJson = parseOptionalJson(packageText);
    const pyproject = await maybeScopedText(this.#scope, path.join(root, 'pyproject.toml'), 32 * 1024, true);

    const completeOutput = {
      root,
      repository: has('.git'),
      buildSystems: [
        has('package.json') ? 'node' : null,
        has('Cargo.toml') ? 'cargo' : null,
        has('pyproject.toml') ? 'python' : null,
        has('CMakeLists.txt') ? 'cmake' : null,
        has('pom.xml') ? 'maven' : null,
        has('build.gradle') || has('build.gradle.kts') ? 'gradle' : null
      ].filter(Boolean),
      packageManager: has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('package-lock.json') ? 'npm' : null,
      scripts: packageJson && typeof packageJson === 'object' ? (packageJson as Record<string, unknown>).scripts ?? null : null,
      manifests: names.filter((name) => ['package.json', 'Cargo.toml', 'pyproject.toml', 'pom.xml', 'CMakeLists.txt', 'build.gradle', 'build.gradle.kts'].includes(name)),
      pyprojectDetected: pyproject !== null,
      observedAt: new Date().toISOString()
    };

    const output = boundProjectMetadata(completeOutput, action.input);

    return {
      ok: true,
      capability: action.capability,
      provider: this.name,
      output,
      evidence: [evidence('project_model', 'pass', 'Project metadata derived from files in authorized scope.', { root })],
      durationMs: Math.round(performance.now() - started)
    };
  }
}

function parseOptionalJson(content: string | null): unknown | null {
  if (content === null) return null;
  try { return JSON.parse(content); } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

/** Read a bounded manifest through the existing per-file path authority boundary. */
async function maybeScopedText(
  scope: PathScope, filePath: string, maxBytes: number, prefixOnly = false
): Promise<string | null> {
  try {
    await fs.lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }

  try {
    return await scope.withExisting(filePath, async (resolved) => {
      const handle = await fs.open(resolved, 'r');
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) {
          throw new OperatorError('PROJECT_MANIFEST_NOT_FILE', 'Project manifest is not a regular file.');
        }
        if (!prefixOnly && stat.size > maxBytes) {
          throw new OperatorError('PROJECT_MANIFEST_TOO_LARGE', 'Project manifest exceeds the safe inspection limit.');
        }
        // Never use unbounded readFile on a project-controlled manifest. A
        // concurrently growing file cannot force a memory-unbounded read.
        const limit = maxBytes + (prefixOnly ? 0 : 1);
        const buffer = Buffer.alloc(limit);
        let used = 0;
        while (used < limit) {
          const { bytesRead } = await handle.read(buffer, used, limit - used, used);
          if (bytesRead === 0) break;
          used += bytesRead;
        }
        if (!prefixOnly && used > maxBytes) {
          throw new OperatorError('PROJECT_MANIFEST_TOO_LARGE', 'Project manifest exceeds the safe inspection limit.');
        }
        return buffer.toString('utf8', 0, used);
      } finally {
        await handle.close();
      }
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    // Never convert an authorization or path-lease denial to missing metadata.
    throw error;
  }
}

const DEFAULT_PROJECT_INSPECT_BYTES = 49_152;
const MAX_PROJECT_INSPECT_BYTES = 131_072;
const MAX_SCRIPT_ENTRIES_PER_PAGE = 256;
const byteLength = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');

/**
 * project.inspect can include arbitrary package.json scripts. Apply the public
 * tool's existing offset/maxBytes parameters to script entry pagination, with
 * an independent byte bound over the complete response. Never imply that a
 * partially returned script dictionary was complete.
 */
function boundProjectMetadata(
  full: Record<string, unknown>,
  input: Record<string, unknown>
): Record<string, unknown> {
  const offset = input.offset === undefined ? 0 : input.offset;
  const maxBytes = input.maxBytes === undefined ? DEFAULT_PROJECT_INSPECT_BYTES : input.maxBytes;
  if (!Number.isSafeInteger(offset) || (offset as number) < 0
    || !Number.isSafeInteger(maxBytes) || (maxBytes as number) < 1024
    || (maxBytes as number) > MAX_PROJECT_INSPECT_BYTES) {
    throw new OperatorError('PROJECT_INSPECT_PAGINATION_INVALID', 'project.inspect offset or maxBytes is invalid.');
  }
  const start = offset as number;
  const budget = maxBytes as number;
  if (start === 0 && byteLength(full) <= budget) return full;

  const { scripts, ...base } = full;
  if (scripts !== null && (typeof scripts !== 'object' || Array.isArray(scripts))) {
    throw new OperatorError('PROJECT_INSPECT_SCRIPTS_INVALID', 'Script metadata cannot be safely paginated.');
  }
  const entries = scripts ? Object.entries(scripts) : [];
  const total = entries.length;
  const sourceSha256 = crypto.createHash('sha256').update(JSON.stringify(scripts ?? null)).digest('hex');
  const pageScripts: Record<string, unknown> = Object.create(null);
  let next = Math.min(start, total);
  for (let index = next; index < total && index < start + MAX_SCRIPT_ENTRIES_PER_PAGE; index += 1) {
    const [name, value] = entries[index]!;
    pageScripts[name] = value;
    const candidate = {
      ...base, scripts: pageScripts,
      scriptPage: { offset: start, nextOffset: index + 1 < total ? index + 1 : null, total, sourceSha256 }
    };
    if (byteLength(candidate) > budget) {
      delete pageScripts[name];
      if (index === Math.min(start, total)) {
        throw new OperatorError(
          'PROJECT_INSPECT_ENTRY_EXCEEDS_BUDGET',
          'The next project script exceeds maxBytes; raise the permitted output budget or inspect a narrower source.'
        );
      }
      break;
    }
    next = index + 1;
  }
  const output = {
    ...base, scripts: pageScripts,
    scriptPage: { offset: start, nextOffset: next < total ? next : null, total, sourceSha256 }
  };
  if (byteLength(output) > budget) {
    throw new OperatorError('PROJECT_INSPECT_OUTPUT_EXCEEDS_BUDGET', 'Project metadata exceeds maxBytes even without scripts.');
  }
  return output;
}
