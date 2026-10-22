import { OperatorError } from './errors.ts';
import type {
  TaskPlanningInfluence,
  TaskPlanningInfluenceProvider,
  TaskPlanningInfluenceRequest
} from './task-orchestrator-contracts.ts';
import type { PlannerEventDecision, PlannerEventKind, TaskPlannerEvent } from './task-planner-event.ts';

type ModelCommand = 'ALLOW' | 'REOBSERVE' | 'REPLAN' | 'WAIT' | 'FAIL_SAFE';
const EVENT_KINDS = new Set<PlannerEventKind>([
  'STALE_TARGET', 'AMBIGUOUS_TARGET', 'ACTION_SUCCEEDED_BUT_NO_PROGRESS',
  'SETTLE_TIMEOUT', 'UI_CHANGED', 'RESOURCE_BUSY', 'STATE_CHANGED',
  'RECONCILIATION_REQUIRED', 'PROVIDER_TEMPORARILY_UNAVAILABLE'
]);
const EVENT_DECISIONS = new Set<PlannerEventDecision>([
  'REOBSERVE', 'REPLAN', 'REPAIR', 'RECONCILE', 'WAIT', 'FAIL'
]);

function invalid(message: string): never {
  throw new OperatorError('TASK_MODEL_INFLUENCE_INVALID', message);
}

function parseReply(value: unknown): ModelCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Local advisory reply must be a JSON object.');
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).length !== 1 || typeof raw.command !== 'string' ||
      !['ALLOW', 'REOBSERVE', 'REPLAN', 'WAIT', 'FAIL_SAFE'].includes(raw.command)) {
    invalid('Local advisory response contains an unsupported command or field.');
  }
  return raw.command as ModelCommand;
}

function influence(
  proposalDigest: string,
  command: TaskPlanningInfluence['command'],
  effect: TaskPlanningInfluence['effect'],
  reason: string
): TaskPlanningInfluence {
  return {
    proposalDigest, command, effect, reason,
    grantsAuthority: false,
    runtimeVetoRequired: true
  };
}

function lastBoundedEvent(events: TaskPlannerEvent[]): Pick<TaskPlannerEvent, 'kind' | 'decision'> | undefined {
  const candidate = events.at(-1);
  if (!candidate || !EVENT_KINDS.has(candidate.kind) || !EVENT_DECISIONS.has(candidate.decision)) return undefined;
  return { kind: candidate.kind, decision: candidate.decision };
}

/**
 * A strictly local, opt-in *veto-only* model for an existing authoritative TaskOrchestrator.
 * It cannot synthesize actions, change task goals, grant authority, or mark steps verified.
 * Only fixed runtime event enums and bounded counters reach the local model; no file/page
 * content, task objective, target paths, actions, passwords, or observation payloads.
 */
export class LoopbackOllamaPlanningInfluence implements TaskPlanningInfluenceProvider {
  readonly #model: string;
  readonly #fetch: typeof fetch;

  constructor(options: { model: string; fetchFn?: typeof fetch }) {
    if (typeof options.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(options.model)) {
      invalid('Local advisory model identifier is invalid.');
    }
    this.#model = options.model;
    this.#fetch = options.fetchFn ?? fetch;
  }

  async review(request: TaskPlanningInfluenceRequest): Promise<TaskPlanningInfluence | undefined> {
    // Never let advisory AI bypass the existing uncertain-side-effect reconciliation barrier.
    const event = lastBoundedEvent(request.recentEvents);
    if (!event) return undefined;
    if (event.decision === 'RECONCILE') {
      return influence(request.proposalDigest, 'RECONCILE', 'CONTROL_ALLOWED',
        'Authoritative runtime event requires reconciliation before another action.');
    }
    if (!['REOBSERVE', 'REPLAN', 'WAIT', 'FAIL'].includes(event.decision)) return undefined;

    const prompt = [
      'You are a safety-only advisor for a task execution runtime. Return only JSON: {"command":"ALLOW"} or one of',
      '{"command":"REOBSERVE"}, {"command":"REPLAN"}, {"command":"WAIT"}, {"command":"FAIL_SAFE"}.',
      'You cannot grant permissions, select tools, modify goals, make claims of completion, or invent observations.',
      'Choose a non-ALLOW response only if supported by the previous verified runtime event.',
      'Runtime event: ' + JSON.stringify(event),
      'Candidate risk class: ' + JSON.stringify(request.risk),
      'Remaining task steps: ' + Math.max(0, Math.floor(request.budget.remainingSteps)),
      'Previous planning iterations: ' + Math.max(0, Math.floor(request.budget.plannerIterations))
    ].join('\n');

    const timeoutMs = Math.min(8_000, Math.max(1, request.budget.activeDeadlineMsRemaining));
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new OperatorError('TASK_MODEL_INFLUENCE_TIMEOUT', 'Local advisory model exceeded its deadline.'));
        }, timeoutMs);
      });
      const command = await Promise.race([this.#modelCommand(prompt, controller.signal), deadline]);
      if (command === 'ALLOW') return undefined;

      const allowed = (command === 'REOBSERVE' && event.decision === 'REOBSERVE')
        || (command === 'REPLAN' && event.decision === 'REPLAN')
        || (command === 'WAIT' && event.decision === 'WAIT')
        || (command === 'FAIL_SAFE' && event.decision === 'FAIL');
      if (!allowed) {
        return influence(request.proposalDigest, 'VERIFY', 'CONTROL_BLOCKED',
          'Advisory command was not supported by the latest authoritative runtime event.');
      }
      return influence(request.proposalDigest,
        command === 'REOBSERVE' ? 'OBSERVE' : command,
        'CONTROL_ALLOWED',
        'Local model requested a bounded veto supported by the latest runtime event.');
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
    }
  }

  async #modelCommand(prompt: string, signal: AbortSignal): Promise<ModelCommand> {
    let response: Response;
    try {
      response = await this.#fetch('http://127.0.0.1:11434/api/generate', {
        method: 'POST', redirect: 'error', signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.#model, prompt, stream: false, format: 'json',
          options: { temperature: 0, num_predict: 80 }
        })
      });
    } catch {
      throw new OperatorError('TASK_MODEL_INFLUENCE_UNAVAILABLE', 'Local advisory model was unavailable.');
    }
    if (!response.ok || !response.body) {
      throw new OperatorError('TASK_MODEL_INFLUENCE_UNAVAILABLE', 'Local advisory model returned an unsuccessful response.');
    }
    const declaredBytes = Number(response.headers.get('content-length'));
    if (declaredBytes > 16_384) invalid('Local advisory model response exceeded the size limit.');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let count = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      count += value.byteLength;
      if (count > 16_384) {
        void reader.cancel();
        invalid('Local advisory model response exceeded the size limit.');
      }
      chunks.push(value);
    }
    let parsed: unknown;
    try {
      const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
      if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) ||
          typeof (envelope as { response?: unknown }).response !== 'string') {
        invalid('Local advisory model returned an invalid response envelope.');
      }
      const responseText = (envelope as { response: string }).response;
      if (responseText.length > 2048) invalid('Local advisory model text exceeds limit.');
      parsed = JSON.parse(responseText);
    } catch (error) {
      if (error instanceof OperatorError) throw error;
      invalid('Local advisory model returned malformed JSON.');
    }
    return parseReply(parsed);
  }
}
