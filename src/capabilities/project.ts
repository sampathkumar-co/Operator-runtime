import fs from 'node:fs/promises';
import path from 'node:path';
import type { ActionRequest, ActionResult, CapabilityProvider, CapabilityScore } from '../core/types.ts';
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

  constructor(options: { allowedRoots: string[] }) { this.#scope = new PathScope(options.allowedRoots); }
  supports(action: ActionRequest): boolean { return action.capability === 'project.inspect'; }
  score(): CapabilityScore { return SCORE; }

  async execute(action: ActionRequest): Promise<ActionResult> {
    const started = performance.now();
    const root = await this.#scope.resolveExisting(String(action.input.path ?? ''));
    const names = await fs.readdir(root);
    const has = (name: string) => names.includes(name);
    const packageJson = await maybeJson(path.join(root, 'package.json'));
    const pyproject = await maybeText(path.join(root, 'pyproject.toml'), 32 * 1024);

    const output = {
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

async function maybeJson(filePath: string): Promise<unknown | null> {
  try { return JSON.parse(await fs.readFile(filePath, 'utf8')); } catch { return null; }
}
async function maybeText(filePath: string, max: number): Promise<string | null> {
  try { return (await fs.readFile(filePath, 'utf8')).slice(0, max); } catch { return null; }
}
