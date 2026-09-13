import type { ActionRequest, ActionResult, CapabilityProvider, CapabilityScore } from '../core/types.ts';
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
    if (action.capability === 'git.diff' && action.input.publicLiteralFiles === true) {
      if (paths.length === 0) return gitFailure(action, 'GIT_PUBLIC_PATH_FILTER_REQUIRED', 'Public Git diff requires explicit literal file paths.');
      const names = await this.#run(action, cwd, [...SAFE_GIT_PREFIX, 'diff', '--name-only', '--no-ext-diff', '--no-textconv', '--', ...paths]);
      if (!names.ok) return names;
      const changed = String((names.output as Record<string, unknown> | undefined)?.stdout ?? '').split(/\r?\n/).filter(Boolean).map(normalizeGitPath);
      const requested = new Set(paths.map(normalizeGitPath));
      if (changed.some((name) => !requested.has(name))) return gitFailure(action, 'GIT_PUBLIC_PATH_FILTER_INVALID', 'Public Git diff accepts literal file paths only, not directories or expanding pathspecs.');
    }
    const args = action.capability === 'git.status'
      ? [...SAFE_GIT_PREFIX, 'status', '--porcelain=v2', '--branch']
      : action.capability === 'git.diff'
        ? [...SAFE_GIT_PREFIX, 'diff', '--no-ext-diff', '--no-textconv', '--', ...paths]
        : [...SAFE_GIT_PREFIX, 'rev-parse', '--show-toplevel'];
    return await this.#run(action, cwd, args);
  }

  async #run(action: ActionRequest, cwd: string, args: string[]): Promise<ActionResult> {
    const result = await this.#process.execute({ ...action, capability: 'terminal.execute', input: { executable: 'git', args, cwd, timeoutMs: 30_000 } });
    return { ...result, capability: action.capability, provider: this.name };
  }
}

function normalizeGitPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '');
}

function gitFailure(action: ActionRequest, code: string, message: string): ActionResult {
  return { ok: false, capability: action.capability, provider: 'git.native', evidence: [], error: { code, message, retryable: false }, durationMs: 0 };
}
