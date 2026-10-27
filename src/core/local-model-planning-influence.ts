import { OperatorError } from './errors.ts';
import { LoopbackOllamaModelGoalGenerator } from './loopback-ollama-model-goal-generator.ts';
import type { ModelGoalGenerator } from './bounded-model-goal-inference.ts';
import type {
  TaskPlanningInfluence, TaskPlanningInfluenceProvider, TaskPlanningInfluenceRequest
} from './task-orchestrator-contracts.ts';
import type { PlannerEventDecision, PlannerEventKind, TaskPlannerEvent } from './task-planner-event.ts';

type SupportedDecision = Extract<PlannerEventDecision, 'REOBSERVE' | 'REPLAN' | 'RECONCILE' | 'WAIT' | 'FAIL'>;
type ModelCommand = 'ALLOW' | 'REOBSERVE' | 'REPLAN' | 'WAIT' | 'FAIL_SAFE';
const MODEL_ID = /^(?=.{1,128}$)[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*(?::[A-Za-z0-9][A-Za-z0-9._-]*)?$/;
const EVENT_KINDS = new Set<PlannerEventKind>([
  'STALE_TARGET', 'AMBIGUOUS_TARGET', 'ACTION_SUCCEEDED_BUT_NO_PROGRESS',
  'SETTLE_TIMEOUT', 'UI_CHANGED', 'RESOURCE_BUSY', 'STATE_CHANGED',
  'RECONCILIATION_REQUIRED', 'PROVIDER_TEMPORARILY_UNAVAILABLE'
]);
const DECISIONS = new Set<PlannerEventDecision>(['REOBSERVE','REPLAN','RECONCILE','WAIT','FAIL']);

function invalid(message: string): never {
  throw new OperatorError('TASK_MODEL_INFLUENCE_INVALID', message);
}
function boundedCounter(value: number, max = 1_000_000): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    invalid('Local model advisor needs bounded verified runtime counters.');
  }
  return value;
}
function influence(digest: string, command: TaskPlanningInfluence['command'],
  effect: TaskPlanningInfluence['effect'], reason: string): TaskPlanningInfluence {
  return { proposalDigest: digest, command, effect, reason, grantsAuthority: false, runtimeVetoRequired: true };
}
function lastEvent(events: TaskPlannerEvent[]): { kind: PlannerEventKind; decision: SupportedDecision; at: string } | undefined {
  // Optional advisor input remains untrusted until canonical event ownership
  // is checked. Array.at() and event getters may execute injected code.
  if (!Array.isArray(events) || events.length > 100 ||
      Object.getPrototypeOf(events) !== Array.prototype ||
      Reflect.ownKeys(events).length !== events.length + 1) {
    invalid('Runtime advisor event history must be a bounded dense plain array.');
  }
  if (events.length === 0) return undefined;
  const slot = Object.getOwnPropertyDescriptor(events, String(events.length - 1));
  if (!slot || !slot.enumerable || !('value' in slot)) {
    invalid('Runtime advisor event is missing or accessor-backed.');
  }
  const raw = slot.value as unknown;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
      (Object.getPrototypeOf(raw) !== Object.prototype &&
       Object.getPrototypeOf(raw) !== null)) {
    invalid('Runtime advisor event is not inert data.');
  }
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  const read = (field: 'kind' | 'decision' | 'at'): unknown => {
    const descriptor = descriptors[field];
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      invalid('Runtime advisor event has an executable or missing required field.');
    }
    return descriptor.value;
  };
  const kind = read('kind') as PlannerEventKind;
  const decision = read('decision') as PlannerEventDecision;
  const at = read('at');
  if (!EVENT_KINDS.has(kind) || !DECISIONS.has(decision)) return undefined;
  if (typeof at !== 'string' || at.length > 64 || !Number.isFinite(Date.parse(at))) {
    return undefined;
  }
  return { kind, decision: decision as SupportedDecision, at };
}
function parseAdvice(text: string): ModelCommand {
  let decoded: unknown;
  try { decoded = JSON.parse(text); }
  catch { invalid('Local model advice is not valid JSON.'); }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded) ||
      Object.getPrototypeOf(decoded) !== Object.prototype ||
      Reflect.ownKeys(decoded).length !== 1 ||
      !Object.hasOwn(decoded, 'command') ||
      !('value' in Object.getOwnPropertyDescriptor(decoded, 'command')!)) {
    invalid('Local advisor response must be a single inert command field.');
  }
  const value = (decoded as { command?: unknown }).command;
  if (value !== 'ALLOW' && value !== 'REOBSERVE' && value !== 'REPLAN' &&
      value !== 'WAIT' && value !== 'FAIL_SAFE') invalid('Local advisor response contains unsupported control.');
  return value;
}

/**
 * Optional source-level provider. Never auto-configured. The model may only
 * veto an already-authorized exact proposal under the canonical runtime's
 * digest, policy, reconciliation and action-dispatch fences.
 *
 * The model sees ONLY an enum event, a risk category and bounded counters.
 * No user objective, path, selected action, observations, workspace files,
 * credentials, process output or proposed action bytes are transmitted.
 */
export class LoopbackOllamaPlanningInfluence implements TaskPlanningInfluenceProvider {
  readonly #model: string;
  readonly #generator: ModelGoalGenerator;
  constructor(options: { model: string; generator?: ModelGoalGenerator; fetchFn?: typeof fetch }) {
    if (!options || typeof options.model !== 'string' || !MODEL_ID.test(options.model) ||
        (options.generator && options.fetchFn)) invalid('Local advisory model configuration is invalid.');
    this.#model = options.model;
    this.#generator = options.generator ?? new LoopbackOllamaModelGoalGenerator({ fetchFn: options.fetchFn });
  }

  async review(request: TaskPlanningInfluenceRequest): Promise<TaskPlanningInfluence | undefined> {
    if (!request || typeof request.proposalDigest !== 'string' ||
        !/^[a-f0-9]{64}$/.test(request.proposalDigest)) invalid('Advisor proposal digest is invalid.');
    const event = lastEvent(request.recentEvents);
    if (!event) return undefined;
    // No model call and no advisory ALLOW may ever bypass an unreconciled
    // side effect. Later unrelated successes are not proof of reconciliation.
    if (event.decision === 'RECONCILE') return influence(request.proposalDigest, 'RECONCILE',
      'CONTROL_ALLOWED', 'Canonical runtime requires reconciliation before dispatch.');

    if (event.decision !== 'REOBSERVE' && event.decision !== 'REPLAN' &&
        event.decision !== 'WAIT' && event.decision !== 'FAIL') return undefined;

    const previous = request.task.execution?.records.at(-1);
    const lastAt = event.at;
    if (previous?.state === 'SUCCEEDED' && typeof previous.finishedAt === 'string' &&
        typeof lastAt === 'string' &&
        Number.isFinite(Date.parse(previous.finishedAt)) && Number.isFinite(Date.parse(lastAt)) &&
        Date.parse(previous.finishedAt) > Date.parse(lastAt)) return undefined;

    const remain = boundedCounter(request.budget.remainingSteps);
    const iterations = boundedCounter(request.budget.plannerIterations);
    const deadlineMs = boundedCounter(request.budget.activeDeadlineMsRemaining, 60 * 60_000);
    if (!['read', 'write', 'external', 'system', 'destructive'].includes(request.risk) ||
        typeof request.reserveModelBudget !== 'function' ||
        !request.signal || typeof request.signal.aborted !== 'boolean' ||
        typeof request.signal.addEventListener !== 'function') {
      invalid('Advisory requires a canonical risk and durable budget/Stop authority.');
    }
    if (request.signal.aborted) throw new OperatorError('TASK_MODEL_INFLUENCE_ABORTED', 'Planning was stopped before advisory inference.');
    if (deadlineMs < 1) throw new OperatorError('TASK_MODEL_INFLUENCE_TIMEOUT', 'Planning deadline is exhausted.');

    const prompt = JSON.stringify({
      instruction: 'Return JSON only: {"command":"ALLOW|REOBSERVE|REPLAN|WAIT|FAIL_SAFE"}. This is veto-only advice. Do not infer authorizations, tools, user goals, completion or unseen machine facts. Non-ALLOW advice must match the latest runtime decision.',
      kind: event.kind,
      runtimeDecision: event.decision,
      risk: request.risk,
      remainingSteps: remain,
      plannerIterations: iterations
    });
    const maxTokens = 80;
    const estimatedPromptTokens = Math.ceil(Buffer.byteLength(prompt, 'utf8') / 4);
    const controller = new AbortController();
    const signal = AbortSignal.any([request.signal, controller.signal]);
    const durationMs = Math.min(8_000, deadlineMs);
    const begunAt = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new OperatorError('TASK_MODEL_INFLUENCE_TIMEOUT', 'Local advisory exceeded its bounded deadline.'));
      }, durationMs);
    });
    let onAbort: (() => void) | undefined;
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => reject(new OperatorError('TASK_MODEL_INFLUENCE_ABORTED', 'Canonical task control stopped advisory.'));
      request.signal!.addEventListener('abort', onAbort!, { once: true });
      if (request.signal!.aborted) onAbort!();
    });
    try {
      // The deadline and Stop race MUST also enclose durable reservation.
      // A late or indefinitely hung callback cannot subsequently send any
      // model prompt, even when it ignores AbortSignal.
      await Promise.race([
        request.reserveModelBudget(estimatedPromptTokens + maxTokens),
        timeout,
        cancelled
      ]);
      if (signal.aborted) {
        throw new OperatorError('TASK_MODEL_INFLUENCE_ABORTED', 'Planning stopped after reservation.');
      }
      if (performance.now() - begunAt >= durationMs) {
        throw new OperatorError('TASK_MODEL_INFLUENCE_TIMEOUT', 'Planning expired while reserving model budget.');
      }
      const response = await Promise.race([
        this.#generator.generate({ modelId: this.#model, prompt, maxOutputTokens: maxTokens, signal }),
        timeout,
        cancelled
      ]);
      if (signal.aborted) throw new OperatorError('TASK_MODEL_INFLUENCE_ABORTED', 'Advisory response arrived after Stop.');
      const command = parseAdvice(response.text);
      if (command === 'ALLOW') return undefined;
      const match = (command === 'REOBSERVE' && event.decision === 'REOBSERVE')
        || (command === 'REPLAN' && event.decision === 'REPLAN')
        || (command === 'WAIT' && event.decision === 'WAIT')
        || (command === 'FAIL_SAFE' && event.decision === 'FAIL');
      if (!match) return influence(request.proposalDigest, 'VERIFY', 'CONTROL_BLOCKED',
        'Model advice not supported by the latest authoritative event.');
      return influence(request.proposalDigest,
        command === 'REOBSERVE' ? 'OBSERVE' : command,
        'CONTROL_ALLOWED', 'Verified event permits this restricted advisory veto.');
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) request.signal!.removeEventListener('abort', onAbort);
      controller.abort();
    }
  }
}
