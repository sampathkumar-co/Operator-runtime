import os from 'node:os';
import type { ActionRequest, ActionResult, CapabilityProvider, CapabilityScore } from '../core/types.ts';
import { evidence } from '../core/evidence.ts';

const SCORE: CapabilityScore = {
  reliability: 1,
  latency: 1,
  determinism: 1,
  security: 0.99,
  reversibility: 1,
  informationQuality: 0.95,
  interactionCost: 0
};

export class SystemInspectProvider implements CapabilityProvider {
  readonly name = 'system.native';
  supports(action: ActionRequest): boolean { return action.capability === 'computer.inspect'; }
  score(): CapabilityScore { return SCORE; }

  async execute(action: ActionRequest): Promise<ActionResult> {
    const started = performance.now();
    const output = {
      hostname: os.hostname(),
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      cpuCount: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
      node: process.version
    };
    return {
      ok: true,
      capability: action.capability,
      provider: this.name,
      output,
      evidence: [evidence('computer_state', 'pass', 'Computer state gathered using native APIs.')],
      durationMs: Math.round(performance.now() - started)
    };
  }
}
