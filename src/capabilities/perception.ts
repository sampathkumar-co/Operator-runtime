import type { ActionRequest, ActionResult, CapabilityExecutionContext, CapabilityProvider, CapabilityScore } from '../core/types.ts';
import { evidence } from '../core/evidence.ts';
import { OperatorError } from '../core/errors.ts';
import type { PerceptionGraphStore, PerceptionObservation } from '../core/perception-graph.ts';

const SCORE: CapabilityScore = {
  reliability: 0.99,
  latency: 0.98,
  determinism: 0.99,
  security: 0.99,
  reversibility: 1,
  informationQuality: 0.98,
  interactionCost: 0
};

export class PerceptionProvider implements CapabilityProvider {
  readonly name = 'perception.graph';
  #graph: PerceptionGraphStore;

  constructor(graph: PerceptionGraphStore) {
    this.#graph = graph;
  }

  supports(action: ActionRequest): boolean {
    return action.capability === 'perception.observe' || action.capability === 'perception.ground';
  }

  score(): CapabilityScore { return SCORE; }

  async execute(action: ActionRequest, _context: CapabilityExecutionContext = {}): Promise<ActionResult> {
    const started = performance.now();
    try {
      if (action.capability === 'perception.observe') {
        const observations = normalizeObservations(action.input);
        const published: Array<{ nodeId: string; sceneKey: string; semanticId?: string; claimCount: number }> = [];
        for (const observation of observations) {
          const node = await this.#graph.observe(observation);
          published.push({
            nodeId: node.id,
            sceneKey: node.sceneKey,
            ...(node.semanticId ? { semanticId: node.semanticId } : {}),
            claimCount: node.claims.length
          });
        }
        return {
          ok: true,
          capability: action.capability,
          provider: this.name,
          output: { published },
          evidence: [evidence('perception_graph', 'pass', 'Published bounded evidence-digested perception observations without expanding execution authority.', { count: published.length })],
          durationMs: Math.round(performance.now() - started)
        };
      }

      const target = await this.#graph.ground({
        sceneKey: requiredString(action.input.sceneKey, 1024, 'sceneKey'),
        ...(optionalString(action.input.semanticId, 512, 'semanticId') ? { semanticId: optionalString(action.input.semanticId, 512, 'semanticId') } : {}),
        ...(optionalString(action.input.role, 256, 'role') ? { role: optionalString(action.input.role, 256, 'role') } : {}),
        ...(optionalString(action.input.name, 1024, 'name') ? { name: optionalString(action.input.name, 1024, 'name') } : {}),
        ...(optionalString(action.input.text, 4096, 'text') ? { text: optionalString(action.input.text, 4096, 'text') } : {}),
        ...(action.input.near === undefined ? {} : { near: normalizeBounds(action.input.near) }),
        ...(action.input.minConfidence === undefined ? {} : { minConfidence: normalizeConfidence(action.input.minConfidence) })
      });
      const center = target.bounds
        ? { x: Math.floor(target.bounds.x + target.bounds.width / 2), y: Math.floor(target.bounds.y + target.bounds.height / 2) }
        : undefined;
      return {
        ok: true,
        capability: action.capability,
        provider: this.name,
        output: {
          nodeId: target.node.id,
          ...(target.node.semanticId ? { semanticId: target.node.semanticId } : {}),
          confidence: target.confidence,
          ...(target.role ? { role: target.role } : {}),
          ...(target.name ? { name: target.name } : {}),
          ...(target.text ? { text: target.text } : {}),
          ...(target.bounds ? { bounds: target.bounds } : {}),
          ...(center ? { center } : {}),
          state: target.state,
          channels: target.channels
        },
        evidence: [evidence('perception_grounding', 'pass', 'Resolved one evidence-backed grounded target from the perception graph.', {
          sceneKey: target.node.sceneKey,
          nodeId: target.node.id,
          confidence: target.confidence,
          channels: target.channels
        })],
        durationMs: Math.round(performance.now() - started)
      };
    } catch (error) {
      const op = error instanceof OperatorError
        ? error
        : new OperatorError('PERCEPTION_PROVIDER_FAILED', error instanceof Error ? error.message : String(error), { retryable: false });
      return {
        ok: false,
        capability: action.capability,
        provider: this.name,
        evidence: [evidence('perception_graph', 'fail', op.message, { code: op.code })],
        error: { code: op.code, message: op.message, retryable: op.retryable },
        durationMs: Math.round(performance.now() - started)
      };
    }
  }
}

function normalizeObservations(input: Record<string, unknown>): PerceptionObservation[] {
  const raw = Array.isArray(input.observations)
    ? input.observations
    : input.observation === undefined ? [] : [input.observation];
  if (raw.length < 1 || raw.length > 100) throw new OperatorError('PERCEPTION_PROVIDER_INPUT_INVALID', 'perception.observe requires 1-100 observations.');
  return raw.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new OperatorError('PERCEPTION_PROVIDER_INPUT_INVALID', `observations[${index}] must be an object.`);
    return structuredClone(item as PerceptionObservation);
  });
}

function normalizeBounds(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new OperatorError('PERCEPTION_PROVIDER_INPUT_INVALID', 'near must be bounds.');
  const raw = input as Record<string, unknown>;
  const x = Number(raw.x), y = Number(raw.y), width = Number(raw.width), height = Number(raw.height);
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0 || width > 100_000 || height > 100_000) {
    throw new OperatorError('PERCEPTION_PROVIDER_INPUT_INVALID', 'near bounds are invalid.');
  }
  return { x, y, width, height };
}
function normalizeConfidence(input: unknown): number {
  const value = Number(input);
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new OperatorError('PERCEPTION_PROVIDER_INPUT_INVALID', 'minConfidence must be from 0 to 1.');
  return value;
}
function requiredString(input: unknown, max: number, label: string): string {
  if (typeof input !== 'string' || input.length < 1 || input.length > max || input.includes('\0')) throw new OperatorError('PERCEPTION_PROVIDER_INPUT_INVALID', `${label} is invalid.`);
  return input;
}
function optionalString(input: unknown, max: number, label: string): string | undefined {
  return input === undefined ? undefined : requiredString(input, max, label);
}
