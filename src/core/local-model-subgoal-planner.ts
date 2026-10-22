import { OperatorError } from './errors.ts';
import { AutonomousWorkflowPlanner } from './task-orchestrator.ts';
import { createDurableTaskPlan, normalizeDurableTaskPlan } from './task-plan.ts';
import type {
  PlannerDecision, SemanticTaskGoal, TaskObservation, TaskPlanner, TaskPlannerContext
} from './task-orchestrator-contracts.ts';

const ALLOWED_FAMILIES = new Set([
  'browser', 'file', 'git', 'project', 'app', 'docker', 'postgres',
  'process', 'terminal', 'computer', 'system', 'visual'
]);
const ALLOWED_DOMAINS = new Set([
  'project', 'filesystem', 'git', 'docker', 'database', 'ide',
  'browser', 'uia', 'process', 'system', 'application', 'visual', 'unknown'
]);

function invalid(message: string): never {
  throw new OperatorError('TASK_MODEL_SUBGOAL_INVALID', message);
}
function family(raw: string): string {
  const value = raw.split('.')[0] ?? '';
  return ALLOWED_FAMILIES.has(value) ? value : 'other';
}

/**
 * Selects the ordering of PREAUTHORIZED and DEPENDENCY-READY subgoals only.
 * All action inputs, verification assertions and permissions are established
 * by the existing durable plan. An advisory model never creates or alters them.
 *
 * Does not call a model before the task has a recent verified machine observation.
 */
export class LocalModelAutonomousWorkflowPlanner implements TaskPlanner {
  readonly id = 'operator.autonomous-workflow.v1';
  readonly #builtin = new AutonomousWorkflowPlanner();
  readonly #model: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;

  constructor(options: { model: string; fetchFn?: typeof fetch; now?: () => number }) {
    if (typeof options.model !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(options.model)) {
      invalid('Local planner model identifier is invalid.');
    }
    this.#model = options.model;
    this.#fetch = options.fetchFn ?? fetch;
    this.#now = options.now ?? Date.now;
  }

  supports(goal: SemanticTaskGoal): boolean { return this.#builtin.supports(goal); }

  async next(context: TaskPlannerContext): Promise<PlannerDecision> {
    const goal = context.goal;
    if (goal.kind !== 'autonomous-workflow') return invalid('Autonomous planner needs a typed autonomous-workflow goal.');
    const state = context.task.execution?.plannerState;
    if (!state) return invalid('Autonomous task execution metadata is missing.');
    if (state.activeSubgoalId !== undefined) return this.#builtin.next(context);

    const last = context.task.execution!.records.at(-1);
    const observation = last?.observation;
    const observedAt = observation?.observedAt ? Date.parse(observation.observedAt) : NaN;
    const ageMs = this.#now() - observedAt;
    // Do not treat uncertain, ambiguous, expired or forged/unpersisted observations
    // as evidence for AI scheduling. Before observation, use deterministic ordering.
    if (last?.state !== 'SUCCEEDED' || observation?.schemaVersion !== 2 ||
      observation.epistemicStatus !== 'KNOWN' || observation.ambiguous ||
      !Number.isFinite(ageMs) || ageMs < 0 || ageMs > 120_000) {
      return this.#builtin.next(context);
    }

    const plan = state.durablePlan === undefined
      ? createDurableTaskPlan({
        taskId: context.task.id, objective: context.task.userObjective,
        constraints: [
          ...context.task.authorizedScope.map(scope => 'authorized:' + scope),
          ...context.task.prohibitedScope.map(scope => 'prohibited:' + scope)
        ],
        finalSuccessConditions: context.task.successConditions,
        steps: goal.steps
      })
      : normalizeDurableTaskPlan(state.durablePlan);

    if (plan.taskId !== context.task.id) return invalid('Stored subgoal plan is not bound to the current task.');
    // normalizeDurableTaskPlan refreshes READY only when dependencies are already verified.
    const ready = plan.subgoals.filter(item => item.status === 'READY');
    if (ready.length < 2) return this.#builtin.next(context);
    if (ready.length > 20) return invalid('Too many ready subgoals for the bounded local model.');

    // Only fixed capability *families*, numeric indexes and evidence metadata.
    // No instructions, paths, browser content, target IDs, action inputs, task
    // objectives, filenames, credentials, text labels or observation payloads.
    const candidates = ready.map((item, index) => ({
      index,
      observe: family(item.execution.observe.capability),
      action: family(item.execution.action.capability),
      verify: family(item.successContract.capability)
    }));
    const prompt = [
      'Choose the safest next item from a finite list of already-authorized, dependency-ready task subgoals.',
      'Return ONLY a JSON object such as {"index":0}. No tool calls, edits, permissions, or new steps.',
      'Favor read-only observation and reversible operations when otherwise equivalent.',
      'Candidates: ' + JSON.stringify(candidates),
      'Last verified observation domain: ' + JSON.stringify(ALLOWED_DOMAINS.has(observation.domain) ? observation.domain : 'unknown'),
      'Last verified observation channel: ' + JSON.stringify(observation.channel === 'visual' ? 'visual' : 'semantic'),
      'Remaining execution actions: ' + Math.max(0, Math.floor(context.budget.remainingSteps))
    ].join('\n');
    const selected = await this.#select(prompt, ready.length, context.signal,
      Math.min(8_000, Math.max(1, Math.floor(context.budget.activeDeadlineMsRemaining))));
    // Delegate still enforces READY status and chooses the exact predeclared
    // observe/action/verify capabilities and the durable independent verifier.
    state.activeSubgoalId = ready[selected]!.id;
    return this.#builtin.next(context);
  }

  accept(context: TaskPlannerContext, step: Extract<PlannerDecision, { type: 'step' }>,
    observation: TaskObservation): void {
    this.#builtin.accept(context, step, observation);
  }
  fallback(context: TaskPlannerContext, step: Extract<PlannerDecision, { type: 'step' }>,
    observation: TaskObservation): boolean {
    return this.#builtin.fallback(context, step, observation);
  }

  async #select(prompt: string, count: number, parent: AbortSignal | undefined, timeoutMs: number): Promise<number> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new OperatorError('TASK_MODEL_SUBGOAL_TIMEOUT', 'Local subgoal selection exceeded its deadline.'));
        }, timeoutMs);
      });
      return await Promise.race([this.#readChoice(prompt, count, signal), deadline]);
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
    }
  }

  async #readChoice(prompt: string, count: number, signal: AbortSignal): Promise<number> {
    let response: Response;
    try {
      response = await this.#fetch('http://127.0.0.1:11434/api/generate', {
        method: 'POST', redirect: 'error', signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.#model, prompt, stream: false, format: 'json',
          options: { temperature: 0, num_predict: 64 } })
      });
    } catch {
      throw new OperatorError('TASK_MODEL_SUBGOAL_UNAVAILABLE', 'Local subgoal model was unavailable.');
    }
    if (!response.ok || !response.body) {
      throw new OperatorError('TASK_MODEL_SUBGOAL_UNAVAILABLE', 'Local subgoal model returned an unsuccessful response.');
    }
    if (Number(response.headers.get('content-length')) > 8192) invalid('Local model reply exceeds byte limit.');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8192) {
        void reader.cancel();
        invalid('Local model reply exceeds byte limit.');
      }
      chunks.push(value);
    }
    let envelope: unknown;
    try { envelope = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { return invalid('Local model reply was not valid JSON.'); }
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) ||
      typeof (envelope as { response?: unknown }).response !== 'string') invalid('Local model envelope is invalid.');
    const text = (envelope as { response: string }).response;
    if (text.length > 1024) invalid('Local model response is too large.');
    let choice: unknown;
    try { choice = JSON.parse(text); } catch { return invalid('Local model selection was not valid JSON.'); }
    if (!choice || typeof choice !== 'object' || Array.isArray(choice)) invalid('Local model selection must be a JSON object.');
    const raw = choice as Record<string, unknown>;
    if (Object.keys(raw).length !== 1 || !Number.isSafeInteger(raw.index) ||
      (raw.index as number) < 0 || (raw.index as number) >= count) invalid('Local model selected a nonexistent or unauthorized subgoal.');
    return raw.index as number;
  }
}
