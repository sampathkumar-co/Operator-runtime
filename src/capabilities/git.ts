import fs from 'node:fs/promises';
import path from 'node:path';
import type { ActionRequest, ActionResult, CapabilityProvider, CapabilityScore } from '../core/types.ts';
import { assertPublicSafePath } from '../core/public-restricted-data.ts';
import { ProcessProvider } from './process.ts';

const SCORE: CapabilityScore = {
  reliability: 0.99,
  latency: 0.98,
  determinism: 0.99,
  security: 0.97,
  reversibility: 0.92,
  informationQuality: 0.99,
  interactionCost: 0.01
};

const SAFE_GIT_PREFIX = ['--no-pager', '-c', 'core.fsmonitor=false'];
const PUBLIC_GIT_PREFIX = [...SAFE_GIT_PREFIX, '--literal-pathspecs'];
const PATHSPEC_META = /[*?\[\]{}]/;

export class GitProvider implements CapabilityProvider {
  readonly name = 'git.native';
  #process: ProcessProvider;

  constructor(options: { allowedRoots: string[] }) {
    this.#process = new ProcessProvider({ allowedRoots: options.allowedRoots, allowedExecutables: ['git'] });
  }

  supports(action: ActionRequest): boolean {
    return ['git.status', 'git.diff', 'git.rev-parse'].includes(action.capability);
  }

  score(): CapabilityScore { return SCORE; }

  async execute(action: ActionRequest): Promise<ActionResult> {
    const cwd = String(action.input.cwd ?? '');
    const paths = Array.isArray(action.input.paths) ? action.input.paths.map(String) : [];
    const publicLiteral = action.capability === 'git.diff' && action.input.publicLiteralFiles === true;

    if (publicLiteral) {
      const validation = await validatePublicLiteralPaths(cwd, paths);
      if (validation) return gitFailure(action, validation.code, validation.message);

      const tracked = await this.#run(action, cwd, [
        ...PUBLIC_GIT_PREFIX, 'ls-files', '-z', '--', ...paths
      ]);
      if (!tracked.ok) return tracked;
      const trackedNames = splitGitNul((tracked.output as Record<string, unknown> | undefined)?.stdout);
      const requested = new Set(paths.map(normalizeGitPath));
      if (trackedNames.some((name) => !requested.has(name))) {
        return gitFailure(action, 'GIT_PUBLIC_PATH_FILTER_INVALID', 'Public Git diff accepts explicit literal files only.');
      }

      const names = await this.#run(action, cwd, [
        ...PUBLIC_GIT_PREFIX, 'diff', '--name-only', '-z', '--no-ext-diff', '--no-textconv', '--', ...paths
      ]);
      if (!names.ok) return names;
      const changed = splitGitNul((names.output as Record<string, unknown> | undefined)?.stdout);
      if (changed.some((name) => !requested.has(name))) {
        return gitFailure(action, 'GIT_PUBLIC_PATH_FILTER_INVALID', 'Git selected a file outside the requested literal set.');
      }
    }

    const prefix = publicLiteral ? PUBLIC_GIT_PREFIX : SAFE_GIT_PREFIX;
    const args = action.capability === 'git.status'
      ? [...SAFE_GIT_PREFIX, 'status', '--porcelain=v2', '--branch']
      : action.capability === 'git.diff'
        ? [...prefix, 'diff', '--no-ext-diff', '--no-textconv', '--', ...paths]
        : [...SAFE_GIT_PREFIX, 'rev-parse', '--show-toplevel'];
    return await this.#run(action, cwd, args);
  }

  async #run(action: ActionRequest, cwd: string, args: string[]): Promise<ActionResult> {
    const result = await this.#process.execute({ ...action, capability: 'terminal.execute', input: { executable: 'git', args, cwd, timeoutMs: 30_000 } });
    return { ...result, capability: action.capability, provider: this.name };
  }
}

async function validatePublicLiteralPaths(
  cwd: string,
  paths: string[]
): Promise<{ code: string; message: string } | undefined> {
  if (paths.length === 0) {
    return { code: 'GIT_PUBLIC_PATH_FILTER_REQUIRED', message: 'Public Git diff requires explicit literal file paths.' };
  }
  for (const raw of paths) {
    const normalized = normalizeGitPath(raw);
    const segments = normalized.split('/');
    if (!raw || raw.trim() !== raw || normalized === '' || normalized === '.' || normalized === '..') {
      return invalidPublicPath();
    }
    if (path.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw) || /^\\\\/.test(raw)) {
      return invalidPublicPath();
    }
    if (raw.startsWith(':') || raw.startsWith('!') || PATHSPEC_META.test(raw)) {
      return invalidPublicPath();
    }
    if (segments.includes('..') || segments.includes('.')) return invalidPublicPath();
    try {
      assertPublicSafePath(normalized);
    } catch {
      return { code: 'RESTRICTED_DATA_PATH_DENIED', message: 'The public plugin cannot access credential or secret-bearing paths.' };
    }
    const resolved = path.resolve(cwd, ...segments);
    const relative = path.relative(path.resolve(cwd), resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return invalidPublicPath();
    try {
      const stat = await fs.lstat(resolved);
      if (stat.isDirectory()) return invalidPublicPath();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') return invalidPublicPath();
    }
  }
  return undefined;
}

function invalidPublicPath(): { code: string; message: string } {
  return {
    code: 'GIT_PUBLIC_PATH_FILTER_INVALID',
    message: 'Public Git diff accepts explicit project-relative literal file paths only.'
  };
}

function splitGitNul(value: unknown): string[] {
  return String(value ?? '').split('\0').filter(Boolean).map(normalizeGitPath);
}

function normalizeGitPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '');
}

function gitFailure(action: ActionRequest, code: string, message: string): ActionResult {
  return {
    ok: false,
    capability: action.capability,
    provider: 'git.native',
    evidence: [],
    error: { code, message, retryable: false },
    durationMs: 0
  };
}
