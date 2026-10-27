import crypto from 'node:crypto';
import { canonicalJson } from './action-identity.ts';
import { OperatorError } from './errors.ts';
import { AutonomousWorkflowPlanner } from './task-orchestrator.ts';
import { createDurableTaskPlan, normalizeDurableTaskPlan, reviseDurableTaskPlan, type DurableTaskPlan, type TaskPlanSubgoal } from './task-plan.ts';
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
 * Owner-provided, provider-neutral inference boundary. This is not a source of
 * authority: return only the candidate index from the supplied safe metadata.
 * An external paid service must be independently authorized and cost-ledgered;
 * the shipping local-agent only uses its fixed loopback implementation.
 */
export interface ReadySubgoalRanker {
  select(input: {
    modelId: string; prompt: string; candidateCount: number;
    signal: AbortSignal; timeoutMs: number;
  }): Promise<number>;
}

export type DynamicSubgoalProposal =
  | { operation: 'none'; observationRef: string }
  | { operation: 'insert_checkpoint'; observationRef: string; beforeIndex: number; schemaIndex: number };

/** Provider-neutral inference boundary for bounded plan composition. The model
 * chooses opaque indexes only; the runtime constructs the complete typed step. */
export interface DynamicSubgoalComposer {
  compose(input: {
    modelId: string; prompt: string; targetCount: number; schemaCount: number;
    observationRef: string; signal: AbortSignal; timeoutMs: number;
  }): Promise<DynamicSubgoalProposal>;
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
  readonly #ranker?: ReadySubgoalRanker;
  readonly #composer?: DynamicSubgoalComposer;
  readonly #enableLoopbackComposition: boolean;

  constructor(options: { model: string; fetchFn?: typeof fetch; now?: () => number; ranker?: ReadySubgoalRanker; composer?: DynamicSubgoalComposer; enableLoopbackComposition?: boolean }) {
    if (typeof options.model !== 'string' ||
      !/^(?=.{1,128}$)[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*(?::[A-Za-z0-9][A-Za-z0-9._-]*)?$/.test(options.model)) {
      invalid('Local planner model identifier is invalid.');
    }
    if (options.ranker !== undefined && typeof options.ranker?.select !== 'function') {
      invalid('Provider-neutral subgoal ranker must implement the bounded selection contract.');
    }
    if (options.composer !== undefined && typeof options.composer?.compose !== 'function') {
      invalid('Provider-neutral subgoal composer must implement the bounded composition contract.');
    }
    if (options.enableLoopbackComposition !== undefined && typeof options.enableLoopbackComposition !== 'boolean') {
      invalid('Local dynamic composition opt-in must be a boolean.');
    }
    if (options.enableLoopbackComposition && options.composer) {
      invalid('Use either the explicit local composition opt-in or an injected provider, never both.');
    }
    this.#enableLoopbackComposition = options.enableLoopbackComposition === true;
    this.#ranker = options.ranker;
    this.#composer = options.composer;
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
    const nowMs = this.#now();
    const ageMs = nowMs - observedAt;
    const startedAt = Date.parse(last?.startedAt ?? '');
    const finishedAt = Date.parse(last?.finishedAt ?? '');
    // A fresh-looking timestamp alone is not independent proof. The exact
    // read capability must have observed within its own persisted action
    // window, and that action must have finished before local model inference.
    const causalRead = last?.risk === 'read' &&
      observation?.schemaVersion === 2 && observation.capability === last.capability &&
      Number.isFinite(startedAt) && Number.isFinite(finishedAt) &&
      Number.isFinite(observedAt) && Number.isFinite(nowMs) &&
      startedAt <= observedAt && observedAt <= finishedAt && finishedAt <= nowMs;
    // Do not treat uncertain, ambiguous, expired or forged/unpersisted observations
    // as evidence for AI scheduling. Before observation, use deterministic ordering.
    if (last?.state !== 'SUCCEEDED' || !/^autonomous:\d+:verify$/.test(last.stepKey) ||
      observation?.schemaVersion !== 2 || observation.epistemicStatus !== 'KNOWN' || observation.ambiguous ||
      !causalRead || !Number.isFinite(ageMs) || ageMs < 0 || ageMs > 120_000) {
      return this.#builtin.next(context);
    }

    let plan = state.durablePlan === undefined
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
    const verifiedSourceIndex = Number(last.stepKey.split(':')[1]);
    if (!plan.subgoals.some(item => item.sourceIndex === verifiedSourceIndex && item.status === 'VERIFIED')) {
      return this.#builtin.next(context);
    }
    plan = await this.#composeCheckpoint(context, plan, verifiedSourceIndex, last.actionId, observation.stateVersion);
    state.durablePlan = plan;
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
    // Charge the task's durable model allowance before touching the local model.
    if (!context.reserveModelBudget) {
      throw new OperatorError('TASK_MODEL_BUDGET_UNAVAILABLE',
        'Local model scheduling requires the canonical durable pre-call reservation authority.');
    }
    if (!context.signal) {
      throw new OperatorError('TASK_PLANNER_ABORTED', 'Model ordering requires the current task Stop fence.');
    }
    const selected = await this.#select(prompt, ready.length, context.signal,
      Math.min(8_000, Math.max(1, Math.floor(context.budget.activeDeadlineMsRemaining))),
      context.reserveModelBudget, Buffer.byteLength(prompt, 'utf8') + 64);
    // Late model outputs after Pause/Cancel must not mutate shared planner state.
    if (context.signal?.aborted) {
      throw new OperatorError('TASK_PLANNER_ABORTED', 'Canceled subgoal selection was discarded.');
    }
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

  async #composeCheckpoint(
    context: TaskPlannerContext,
    plan: DurableTaskPlan,
    verifiedSourceIndex: number,
    actionId: string,
    stateVersion: string
  ): Promise<DurableTaskPlan> {
    // Opt-in dynamic composition must not affect the existing deterministic
    // or injected-ranker planner when no composer was configured.
    if (!this.#composer && !this.#enableLoopbackComposition) return plan;
    if (typeof stateVersion !== 'string' || !/^[0-9a-f]{64}$/i.test(stateVersion)) {
      return plan;
    }
    const state = context.task.execution!.plannerState;
    const observationRef = crypto.createHash('sha256')
      .update(context.task.id).update('\0').update(actionId).update('\0')
      .update(stateVersion).digest('hex');
    if (state.dynamicCompositionObservationRef === observationRef) return plan;
    if (context.signal?.aborted) throw new OperatorError('TASK_PLANNER_ABORTED', 'Dynamic composition was canceled.');
    const priorCompositions = plan.revisions.filter((entry) => entry.reason.startsWith('dynamic-checkpoint:')).length;
    if (priorCompositions >= 4 || context.budget.remainingSteps < 3 || plan.subgoals.length >= 100) {
      state.dynamicCompositionObservationRef = observationRef;
      return plan;
    }
    const source = plan.subgoals.find((item) => item.sourceIndex === verifiedSourceIndex && item.status === 'VERIFIED');
    const sourceStep = context.goal.kind === 'autonomous-workflow'
      ? context.goal.steps[verifiedSourceIndex]
      : undefined;
    if (!source || !sourceStep || sourceStep.key !== source.key || !this.#insideAuthority(context, source)) {
      state.dynamicCompositionObservationRef = observationRef;
      return plan;
    }
    const inputBytes = Buffer.byteLength(canonicalJson(source.successContract.input), 'utf8');
    const schemas = (context.capabilitySchemas ?? [])
      .filter((entry) => entry.stepKey === sourceStep.key && entry.action === 'verify'
        && entry.capability === source.successContract.capability && entry.risk === 'read'
        && entry.inputSchemaVersion === 1 && entry.cancellation === 'required'
        && inputBytes <= entry.inputMaxBytes)
      .slice(0, 20);
    const targets = plan.subgoals
      .filter((item) => item.status === 'READY' && this.#insideAuthority(context, item))
      .slice(0, 20);
    if (schemas.length === 0 || targets.length === 0) {
      state.dynamicCompositionObservationRef = observationRef;
      return plan;
    }
    const prompt = [
      'Decide whether one fresh read-only verification checkpoint is required before a ready task subgoal.',
      'Return ONLY JSON: {"operation":"none","observationRef":"..."} or',
      '{"operation":"insert_checkpoint","observationRef":"...","beforeIndex":0,"schemaIndex":0}.',
      'Indexes select runtime-owned typed contracts. You cannot create actions, inputs, targets, scopes, or authority.',
      'Fresh observation reference: ' + observationRef,
      'Remaining execution actions: ' + Math.max(0, Math.floor(context.budget.remainingSteps)),
      'Targets: ' + JSON.stringify(targets.map((item, index) => ({
        index,
        observe: family(item.execution.observe.capability),
        action: family(item.execution.action.capability),
        verify: family(item.successContract.capability)
      }))),
      'Provider schemas: ' + JSON.stringify(schemas.map((entry, index) => ({
        index, capability: entry.capability, risk: entry.risk,
        inputSchemaVersion: entry.inputSchemaVersion, inputMaxBytes: entry.inputMaxBytes,
        cancellation: entry.cancellation, resourceKinds: entry.resourceKinds.slice(0, 16)
      })))
    ].join('\n');
    if (!context.reserveModelBudget) {
      throw new OperatorError('TASK_MODEL_BUDGET_UNAVAILABLE',
        'Dynamic composition requires the canonical durable pre-call reservation authority.');
    }
    if (!context.signal) {
      throw new OperatorError('TASK_PLANNER_ABORTED', 'Dynamic composition requires the current task Stop fence.');
    }
    const proposal = await this.#requestComposition(
      prompt, targets.length, schemas.length, observationRef, context.signal,
      Math.min(8_000, Math.max(1, Math.floor(context.budget.activeDeadlineMsRemaining))),
      context.reserveModelBudget, Buffer.byteLength(prompt, 'utf8') + 128
    );
    if (context.signal?.aborted) {
      throw new OperatorError('TASK_PLANNER_ABORTED', 'Canceled dynamic composition was discarded.');
    }
    state.dynamicCompositionObservationRef = observationRef;
    if (proposal.operation === 'none') return plan;
    const target = targets[proposal.beforeIndex]!;
    const selected = schemas[proposal.schemaIndex]!;
    // Re-check the exact provider declaration selected by the model before
    // constructing a runtime-owned step. No model-supplied field is copied.
    if (selected.capability !== source.successContract.capability || selected.risk !== 'read'
      || inputBytes > selected.inputMaxBytes) invalid('Selected provider schema no longer matches the checkpoint contract.');
    const key = `dynamic-checkpoint:${plan.revision + 1}:${observationRef.slice(0, 16)}:${proposal.schemaIndex}:${proposal.beforeIndex}`;
    return reviseDurableTaskPlan(plan, [{
      kind: 'insert_prerequisite',
      beforeKey: target.key,
      step: {
        key,
        title: 'Fresh provider-backed verification checkpoint',
        resourceScope: [...source.resourceScope],
        observe: structuredClone(source.successContract),
        action: structuredClone(source.successContract),
        verify: structuredClone(source.successContract)
      }
    }], `dynamic-checkpoint:${observationRef}`);
  }

  #insideAuthority(context: TaskPlannerContext, subgoal: TaskPlanSubgoal): boolean {
    if (subgoal.resourceScope.length < 1) return false;
    if (!subgoal.resourceScope.every((scope) => context.task.authorizedScope.includes(scope))) return false;
    if (subgoal.resourceScope.some((scope) => context.task.prohibitedScope.includes(scope))) return false;
    const target = subgoal.successContract.target;
    return target === undefined || (context.task.authorizedScope.includes(target)
      && !context.task.prohibitedScope.includes(target));
  }

  async #requestComposition(
    prompt: string,
    targetCount: number,
    schemaCount: number,
    observationRef: string,
    parent: AbortSignal,
    timeoutMs: number,
    reserve: (tokens: number) => Promise<void>,
    reservedTokens: number
  ): Promise<DynamicSubgoalProposal> {
    if (parent.aborted) throw new OperatorError('TASK_PLANNER_ABORTED', 'Dynamic composition was stopped before reservation.');
    const controller = new AbortController();
    const startedAt = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const signal = AbortSignal.any([parent, controller.signal]);
      const cancelled = new Promise<never>((_, reject) => {
        onAbort = () => reject(new OperatorError('TASK_PLANNER_ABORTED', 'Dynamic composition was canceled before dispatch.'));
        parent.addEventListener('abort', onAbort, { once: true });
        if (parent.aborted) onAbort();
      });
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new OperatorError('TASK_MODEL_SUBGOAL_TIMEOUT', 'Dynamic composition exceeded its deadline.'));
        }, timeoutMs);
      });
      // Persist a conservative model charge while this same timeout/Stop
      // fence is active. Late or hung reservations cannot send a prompt.
      await Promise.race([reserve(reservedTokens), deadline, cancelled]);
      if (signal.aborted) {
        throw new OperatorError('TASK_PLANNER_ABORTED', 'Subgoal model was stopped during reservation.');
      }
      if (performance.now() - startedAt >= timeoutMs) {
        throw new OperatorError('TASK_MODEL_SUBGOAL_TIMEOUT', 'Model reservation consumed the task decision deadline.');
      }
      const inference = this.#composer
        ? Promise.resolve().then(() => this.#composer!.compose({
            modelId: this.#model, prompt, targetCount, schemaCount, observationRef, signal, timeoutMs
          }))
        : this.#readComposition(prompt, signal);
      const proposal = await Promise.race([inference, deadline, cancelled]);
      return validateCompositionProposal(proposal, targetCount, schemaCount, observationRef);
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) parent.removeEventListener('abort', onAbort);
      controller.abort();
    }
  }

  async #readComposition(prompt: string, signal: AbortSignal): Promise<DynamicSubgoalProposal> {
    const text = await this.#readLocalJson(prompt, signal, 128);
    let proposal: unknown;
    try { proposal = JSON.parse(text); }
    catch { return invalid('Local model composition was not valid JSON.'); }
    return proposal as DynamicSubgoalProposal;
  }

  async #select(prompt: string, count: number, parent: AbortSignal, timeoutMs: number,
    reserve: (tokens: number) => Promise<void>, reservedTokens: number): Promise<number> {
    if (parent.aborted) throw new OperatorError('TASK_PLANNER_ABORTED', 'Local subgoal selection was stopped before reservation.');
    const controller = new AbortController();
    const startedAt = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const signal = AbortSignal.any([parent, controller.signal]);
      const cancelled = new Promise<never>((_, reject) => {
        onAbort = () => reject(new OperatorError('TASK_PLANNER_ABORTED', 'Local model selection was canceled before dispatch.'));
        parent.addEventListener('abort', onAbort, { once: true });
        if (parent.aborted) onAbort();
      });
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new OperatorError('TASK_MODEL_SUBGOAL_TIMEOUT', 'Local subgoal selection exceeded its deadline.'));
        }, timeoutMs);
      });
      // Persist a conservative model charge while this same timeout/Stop
      // fence is active. Late or hung reservations cannot send a prompt.
      await Promise.race([reserve(reservedTokens), deadline, cancelled]);
      if (signal.aborted) {
        throw new OperatorError('TASK_PLANNER_ABORTED', 'Subgoal model was stopped during reservation.');
      }
      if (performance.now() - startedAt >= timeoutMs) {
        throw new OperatorError('TASK_MODEL_SUBGOAL_TIMEOUT', 'Model reservation consumed the task decision deadline.');
      }
      const inference = this.#ranker
        ? Promise.resolve().then(() => this.#ranker!.select({
            modelId: this.#model, prompt, candidateCount: count, signal, timeoutMs
          }))
        : this.#readChoice(prompt, count, signal);
      const selected = await Promise.race([inference, deadline, cancelled]);
      if (!Number.isSafeInteger(selected) || selected < 0 || selected >= count) {
        invalid('Provider-neutral model selected a nonexistent or unauthorized subgoal.');
      }
      return selected;
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) parent.removeEventListener('abort', onAbort);
      controller.abort();
    }
  }

  async #readChoice(prompt: string, count: number, signal: AbortSignal): Promise<number> {
    const text = await this.#readLocalJson(prompt, signal, 64);
    let choice: unknown;
    try { choice = JSON.parse(text); } catch { return invalid('Local model selection was not valid JSON.'); }
    if (!choice || typeof choice !== 'object' || Array.isArray(choice)) invalid('Local model selection must be a JSON object.');
    const raw = choice as Record<string, unknown>;
    if (Object.keys(raw).length !== 1 || !Number.isSafeInteger(raw.index) ||
      (raw.index as number) < 0 || (raw.index as number) >= count) invalid('Local model selected a nonexistent or unauthorized subgoal.');
    return raw.index as number;
  }

  async #readLocalJson(prompt: string, signal: AbortSignal, numPredict: number): Promise<string> {
    let response: Response;
    try {
      response = await this.#fetch('http://127.0.0.1:11434/api/generate', {
        method: 'POST', redirect: 'error', signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.#model, prompt, stream: false, format: 'json',
          options: { temperature: 0, num_predict: numPredict } })
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
    const meta = envelope as Record<string, unknown>;
    // A syntactically valid JSON prefix is not a settled decision if the
    // inference provider declares truncation or a tool-call handoff.
    if ((Object.hasOwn(meta, 'done') && meta.done !== true) ||
        (Object.hasOwn(meta, 'done_reason') && meta.done_reason !== 'stop') ||
        Object.hasOwn(meta, 'tool_calls') || Object.hasOwn(meta, 'function_call')) {
      invalid('Local model decision was incomplete or requested a tool call.');
    }
    const text = (envelope as { response: string }).response;
    if (text.length > 1024) invalid('Local model response is too large.');
    return text;
  }
}

function validateCompositionProposal(
  proposal: unknown,
  targetCount: number,
  schemaCount: number,
  observationRef: string
): DynamicSubgoalProposal {
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal) ||
      (Object.getPrototypeOf(proposal) !== Object.prototype &&
       Object.getPrototypeOf(proposal) !== null)) {
    invalid('Dynamic composition proposal must be a plain inert JSON object.');
  }
  // An injected provider is still untrusted model input. Object.keys() silently
  // ignores symbol/non-enumerable fields and raw property access can execute
  // getters. Take descriptors once and never touch provider-owned properties.
  const descriptors = Object.getOwnPropertyDescriptors(proposal);
  const keys = Reflect.ownKeys(proposal);
  if (keys.some(key => typeof key !== 'string' ||
      !Object.hasOwn(descriptors, key) ||
      !descriptors[key]!.enumerable || !('value' in descriptors[key]!))) {
    invalid('Dynamic composition proposal contains executable or hidden fields.');
  }
  const raw = Object.fromEntries(keys.map(key =>
    [key, descriptors[key as string]!.value])) as Record<string, unknown>;
  if (raw.operation === 'none') {
    if (keys.length !== 2 || !Object.hasOwn(raw, 'operation') ||
        !Object.hasOwn(raw, 'observationRef') || raw.observationRef !== observationRef) {
      invalid('Dynamic composition refusal is not bound to the fresh observation.');
    }
    return { operation: 'none', observationRef };
  }
  if (raw.operation !== 'insert_checkpoint' || keys.length !== 4 ||
    !['operation', 'observationRef', 'beforeIndex', 'schemaIndex'].every(k => Object.hasOwn(raw, k)) ||
    raw.observationRef !== observationRef || !Number.isSafeInteger(raw.beforeIndex)
    || !Number.isSafeInteger(raw.schemaIndex) || (raw.beforeIndex as number) < 0
    || (raw.beforeIndex as number) >= targetCount || (raw.schemaIndex as number) < 0
    || (raw.schemaIndex as number) >= schemaCount) {
    invalid('Dynamic composition selected an unauthorized target, schema, or observation.');
  }
  return {
    operation: 'insert_checkpoint', observationRef,
    beforeIndex: raw.beforeIndex as number, schemaIndex: raw.schemaIndex as number
  };
}
