import type { ActionRequest, ActionResult, CapabilityProvider, CapabilityScore } from '../core/types.ts';
import { ProcessProvider } from './process.ts';

const SCORE: CapabilityScore = {
  reliability: 0.99,
  latency: 0.98,
  determinism: 0.99,
  security: 0.96,
  reversibility: 0.92,
  informationQuality: 0.99,
  interactionCost: 0.01
};

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
    const args = action.capability === 'git.status'
      ? ['status', '--porcelain=v2', '--branch']
      : action.capability === 'git.diff'
        ? ['diff', '--no-ext-diff', '--', ...(Array.isArray(action.input.paths) ? action.input.paths.map(String) : [])]
        : ['rev-parse', '--show-toplevel'];

    const result = await this.#process.execute({
      ...action,
      capability: 'terminal.execute',
      input: { executable: 'git', args, cwd, timeoutMs: 30_000 }
    });
    return { ...result, capability: action.capability, provider: this.name };
  }
}
