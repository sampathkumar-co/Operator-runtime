import crypto from 'node:crypto';
import path from 'node:path';
import { canonicalJson } from './action-identity.ts';
import type { OperatorRuntime } from './runtime.ts';
import type { ActionRequest, ActionResult, ActionRisk, CapabilityExecutionContext, ExecutionPhase, IntentBinding, PermissionProfile, SideEffectState } from './types.ts';
import type { TaskActionRecord, TaskCapsule, TaskExecution, TaskObservationDomain } from './task.ts';
import { addTaskNode, createTask, finalizeTask, setNodeState, stableTaskExecutionNodeKey } from './task.ts';
import { TaskStore } from './task-store.ts';
import { capabilityRiskRule } from './capability-policy.ts';
import { evidence } from './evidence.ts';
import { OperatorError } from './errors.ts';
import { normalizeMachineObservation, observationDomain } from './machine-state.ts';
import { classifyTaskFailure } from './task-failure.ts';
import { verifyGoalOutcomeTruth, verifyTaskCompletion } from './task-verifier.ts';
import { postgresSelectActionInput } from './semantic-task-input.ts';
import { conservativeExecutionPhase, conservativeSideEffectState, retrySafeWithoutReconciliation, validExecutionPhase, validSideEffectState } from './side-effect.ts';
import type { ResourceLeaseStore } from './resource-leases.ts';
import { resourceKeysForAction } from './resource-identity.ts';
import type { IntentRegistry } from './intent-registry.ts';
import type { ActionTransitionJournal } from './action-transition-journal.ts';
import { validIntentBinding } from './intent-registry.ts';

export type UiaTaskOperation = 'invoke' | 'set_value' | 'focus' | 'select' | 'expand' | 'collapse' | 'scroll' | 'activate_window';
export type UiaTaskSelector = { name?: string; automationId?: string; className?: string; controlType?: string; processId?: number };
export type PhysicalInputTaskOperation = 'move' | 'click' | 'double_click' | 'drag' | 'scroll' | 'type_text' | 'key_press' | 'hotkey';
export type VisualTaskSelector = { name?: string; className?: string; processId?: number };
export type AppPhysicalFallback = {
  source: 'screen' | 'window' | 'region';
  selector?: VisualTaskSelector;
  region?: { x: number; y: number; width: number; height: number };
  operation: PhysicalInputTaskOperation;
  x?: number; y?: number; toX?: number; toY?: number;
  deltaX?: number; deltaY?: number;
  text?: string; key?: string; keys?: string[];
  maxWidth?: number; maxHeight?: number;
};
export type PostgresTaskFilter = { column: string; op: 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte' | 'like' | 'ilike' | 'is_null' | 'not_null'; value?: string };
export type PostgresTaskOrder = { column: string; direction: 'asc' | 'desc' };
export type ProjectQualityCheck = 'lint' | 'test' | 'build';

export type AtomicSemanticTaskGoal =
  | { kind: 'controlled-file-change'; root: string; path: string; content: string }
  | { kind: 'trusted-project-command'; root: string; commandKind: 'build' | 'test' | 'lint' }
  | { kind: 'browser-navigation'; url: string; targetId?: string }
  | { kind: 'docker-lifecycle'; root: string; operation: 'start' | 'stop' | 'restart'; services: string[]; timeoutMs?: number }
  | {
      kind: 'postgres-select'; root: string; profileId: string; schema?: string; table: string;
      columns?: string[]; filters?: PostgresTaskFilter[]; orderBy?: PostgresTaskOrder[];
      limit?: number; offset?: number; timeoutMs?: number;
    }
  | {
      kind: 'app-operation'; operation: UiaTaskOperation; selector: UiaTaskSelector;
      value?: string; horizontalAmount?: string; verticalAmount?: string;
      verifySelector?: UiaTaskSelector; waitMs?: number;
      physicalFallback?: AppPhysicalFallback;
    };

export type SemanticTaskGoal =
  | AtomicSemanticTaskGoal
  | { kind: 'project-quality-gate'; root: string; checks?: ProjectQualityCheck[]; requireAll?: boolean }
  | { kind: 'semantic-workflow'; steps: AtomicSemanticTaskGoal[] };

export interface TaskPlannerContext {
  task: TaskCapsule;
  goal: SemanticTaskGoal;
  budget: {
    maxSteps: number;
    usedSteps: number;
    remainingSteps: number;
    plannerIterations: number;
    preDispatchReobserves: number;
    dispatchedActions: number;
    maxAttemptsPerStep: number;
    activeDeadlineMsRemaining: number;
  };
}

/** Stable semantic observation boundary. A future visual provider can populate the
 * same contract with channel="visual" without changing planner control flow. */
export interface TaskObservation {
  channel: 'semantic' | 'visual';
  domain: TaskObservationDomain;
  observedAt: string;
  ok: boolean;
  capability: string;
  provider: string;
  output?: unknown;
  evidence: ActionResult['evidence'];
  error?: ActionResult['error'];
}

export type PlannerDecision =
  | { type: 'complete'; message: string }
  | { type: 'step'; key: string; title: string; capability: string; input: Record<string, unknown>; target?: string };

export interface TaskPlanner {
  readonly id: string;
  supports(goal: SemanticTaskGoal): boolean;
  next(context: TaskPlannerContext): PlannerDecision;
  repair?(context: TaskPlannerContext, invalidDecision: unknown, issue: string): PlannerDecision;
  accept(context: TaskPlannerContext, step: Extract<PlannerDecision, { type: 'step' }>, observation: TaskObservation): void;
  fallback?(context: TaskPlannerContext, step: Extract<PlannerDecision, { type: 'step' }>, observation: TaskObservation): boolean;
}

export interface TaskRunAuthorization {
  permissionProvider?: (action: ActionRequest) => PermissionProfile | Promise<PermissionProfile>;
  onActionResult?: (action: ActionRequest, result: ActionResult) => void | Promise<void>;
  onApprovalRequired?: (
    action: ActionRequest,
    remainingMs: number
  ) => 'retry' | 'deny' | void | Promise<'retry' | 'deny' | void>;
}

export interface SubmitTaskOptions {
  requestId?: string;
  objective: string;
  authorizedScope: string[];
  prohibitedScope?: string[];
  successConditions: string[];
  goal: SemanticTaskGoal;
  maxSteps?: number;
  maxAttemptsPerStep?: number;
  timeoutMs?: number;
  intent?: IntentBinding;
}

export class TaskOrchestrator {
  #runtime: OperatorRuntime;
  #store: TaskStore;
  #permissions: PermissionProfile;
  #planners: Map<string, TaskPlanner>;
  #active = new Map<string, Promise<TaskCapsule>>();
  #controllers = new Map<string, AbortController>();
  #controlRequests = new Map<string, 'PAUSED' | 'CANCELLED'>();
  #stateWriteTails = new Map<string, Promise<void>>();
  #executeAction: (action: ActionRequest, permissions: PermissionProfile, context?: CapabilityExecutionContext) => Promise<ActionResult>;
  #resourceLeases?: ResourceLeaseStore;
  #intentRegistry?: IntentRegistry;
  #actionJournal?: ActionTransitionJournal;
  #wallNow: () => number;
  #monotonicNow: () => number;

  constructor(options: {
    runtime: OperatorRuntime;
    store: TaskStore;
    permissions: PermissionProfile;
    planners?: TaskPlanner[];
    executeAction?: (action: ActionRequest, permissions: PermissionProfile, context?: CapabilityExecutionContext) => Promise<ActionResult>;
    resourceLeases?: ResourceLeaseStore;
    intentRegistry?: IntentRegistry;
    actionJournal?: ActionTransitionJournal;
    wallNow?: () => number;
    monotonicNow?: () => number;
  }) {
    this.#runtime = options.runtime;
    this.#store = options.store;
    const planners = options.planners ?? [new ProjectQualityGatePlanner(), new SemanticTaskPlanner(), new SemanticWorkflowPlanner()];
    this.#planners = new Map(planners.map((planner) => [planner.id, planner]));
    this.#permissions = structuredClone(options.permissions);
    this.#executeAction = options.executeAction ?? ((action, permissions, context) => this.#runtime.execute(action, permissions, context));
    this.#resourceLeases = options.resourceLeases;
    this.#intentRegistry = options.intentRegistry;
    this.#actionJournal = options.actionJournal;
    this.#wallNow = options.wallNow ?? Date.now;
    this.#monotonicNow = options.monotonicNow ?? (() => performance.now());
  }

  async submit(input: SubmitTaskOptions): Promise<TaskCapsule> {
    const goalKind = input.goal && typeof input.goal === 'object' ? String((input.goal as { kind?: unknown }).kind ?? '') : '';
    const goal = parseGoal(input.goal, goalKind);
    const planner = [...this.#planners.values()].find((candidate) => candidate.supports(goal));
    if (!planner) throw new OperatorError('TASK_PLANNER_UNAVAILABLE', `No task planner supports ${goal.kind}.`);

    const normalized = {
      userObjective: boundedText(input.objective, 16_384, 'objective'),
      authorizedScope: boundedTextArray(input.authorizedScope, 1000, 4096, 'authorizedScope'),
      prohibitedScope: boundedTextArray(input.prohibitedScope ?? [], 1000, 4096, 'prohibitedScope'),
      successConditions: boundedTextArray(input.successConditions, 1000, 16_384, 'successConditions'),
      maxSteps: boundedInteger(input.maxSteps, 1, 100, 20),
      maxAttemptsPerStep: boundedInteger(input.maxAttemptsPerStep, 1, 5, 2),
      timeoutMs: boundedInteger(input.timeoutMs, 100, 60 * 60_000, 10 * 60_000),
      ...(input.intent ? { intent: validIntentBinding(input.intent) } : {})
    };
    if (normalized.intent) {
      if (!this.#intentRegistry) throw new OperatorError('INTENT_ENFORCEMENT_UNAVAILABLE', 'Task intent binding requires an IntentRegistry.');
      await this.#intentRegistry.assertExecutable(normalized.intent);
    }
    const requestId = input.requestId === undefined ? undefined : validTaskRequestId(input.requestId);
    if (requestId) {
      try {
        const existing = await this.#store.get(requestId);
        if (!sameTaskSubmission(existing, planner.id, goal, normalized)) {
          throw new OperatorError('TASK_SUBMISSION_ID_CONFLICT', 'Task submission requestId is already bound to a different durable task request.');
        }
        return existing;
      } catch (error) {
        if (!(error instanceof OperatorError) || error.code !== 'TASK_NOT_FOUND') throw error;
      }
    }

    const task = createTask({
      userObjective: normalized.userObjective,
      interpretedObjective: `${goal.kind}:${normalized.userObjective}`,
      authorizedScope: normalized.authorizedScope,
      prohibitedScope: normalized.prohibitedScope,
      successConditions: normalized.successConditions,
      ...(normalized.intent ? { intent: normalized.intent } : {})
    });
    if (requestId) task.id = requestId;
    task.execution = {
      schemaVersion: 1,
      plannerId: planner.id,
      goalKind: goal.kind,
      plannerState: { goal: structuredClone(goal), phase: 'start' },
      maxSteps: normalized.maxSteps,
      maxAttemptsPerStep: normalized.maxAttemptsPerStep,
      timeoutMs: normalized.timeoutMs,
      stepCount: 0,
      plannerIterations: 0,
      preDispatchReobserves: 0,
      dispatchedActions: 0,
      records: []
    };
    if (!requestId) {
      await this.#store.put(task);
      return task;
    }
    try {
      await this.#store.create(task);
      return task;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await this.#store.get(requestId);
      if (!sameTaskSubmission(existing, planner.id, goal, normalized)) {
        throw new OperatorError('TASK_SUBMISSION_ID_CONFLICT', 'Task submission requestId is already bound to a different durable task request.');
      }
      return existing;
    }
  }

  async run(taskId: string, approvedActionIds: string[] = [], authorization: TaskRunAuthorization = {}): Promise<TaskCapsule> {
    const active = this.#active.get(taskId);
    if (active) return await active;
    const controller = new AbortController();
    this.#controllers.set(taskId, controller);
    const promise = this.#runWithLease(taskId, approvedActionIds, authorization, controller.signal).finally(() => {
      this.#active.delete(taskId);
      this.#controllers.delete(taskId);
      this.#controlRequests.delete(taskId);
    });
    this.#active.set(taskId, promise);
    return await promise;
  }

  async #runWithLease(taskId: string, approvedActionIds: string[], authorization: TaskRunAuthorization, signal: AbortSignal): Promise<TaskCapsule> {
    const lease = await this.#store.acquireExecutionLease(taskId);
    try { return await this.#run(taskId, approvedActionIds, authorization, lease.assertOwned, signal); }
    finally { await lease.release(); }
  }

  async #run(taskId: string, approvedActionIds: string[], authorization: TaskRunAuthorization, assertLease: () => Promise<void>, signal: AbortSignal): Promise<TaskCapsule> {
    let task = await this.#store.get(taskId);
    if (!task.execution) throw new OperatorError('TASK_EXECUTION_MISSING', 'Task has no execution metadata.');
    if (task.intent) {
      if (!this.#intentRegistry) throw new OperatorError('INTENT_ENFORCEMENT_UNAVAILABLE', 'Task intent binding requires an IntentRegistry.');
      try {
        await this.#intentRegistry.assertExecutable(task.intent);
      } catch (error) {
        if (error instanceof OperatorError && (error.code === 'INTENT_STALE' || error.code === 'INTENT_NOT_EXECUTABLE')) {
          task.state = 'CANCELLED';
          task.evidence.push(evidence('intent_superseded', 'info', 'Task was cancelled because a newer conversation intent superseded its durable binding.', {
            conversationId: task.intent.conversationId,
            intentVersion: task.intent.intentVersion
          }));
          await this.#store.put(task);
          return task;
        }
        throw error;
      }
    }
    if (['VERIFIED', 'CANCELLED', 'FAILED'].includes(task.state)) return task;
    if (task.state === 'PAUSED') return task;
    const execution = task.execution;
    const planner = this.#planners.get(execution.plannerId);
    if (!planner) throw new OperatorError('TASK_PLANNER_UNAVAILABLE', `Task planner ${execution.plannerId} is unavailable.`);
    const goal = parseGoal(execution.plannerState.goal, execution.goalKind);
    let activeDeadline = this.#monotonicNow() + Math.max(0, execution.deadlineAt ? Date.parse(execution.deadlineAt) - this.#wallNow() : execution.timeoutMs);
    if (!execution.startedAt) {
      execution.startedAt = new Date(this.#wallNow()).toISOString();
      execution.deadlineAt = new Date(this.#wallNow() + execution.timeoutMs).toISOString();
      activeDeadline = this.#monotonicNow() + execution.timeoutMs;
    }
    task.state = 'RUNNING';
    await this.#persistRunState(task, assertLease);

    while (true) {
      task = await this.#store.get(task.id);
      await assertLease();
      if (task.state === 'PAUSED' || task.state === 'CANCELLED') return task;
      if (task.intent) {
        try {
          await this.#intentRegistry!.assertExecutable(task.intent);
        } catch (error) {
          if (error instanceof OperatorError && (error.code === 'INTENT_STALE' || error.code === 'INTENT_NOT_EXECUTABLE')) {
            task.state = 'CANCELLED';
            task.evidence.push(evidence('intent_superseded', 'info', 'Task stopped before the next environment action because a newer intent superseded this execution.', {
              conversationId: task.intent.conversationId,
              intentVersion: task.intent.intentVersion
            }));
            await this.#persistRunState(task, assertLease);
            return task;
          }
          throw error;
        }
      }
      const current = task.execution!;
      const interrupted = await this.#markInterrupted(task);
      if (interrupted > 0) {
        current.deadlineAt = new Date(this.#wallNow() + current.timeoutMs).toISOString();
        activeDeadline = this.#monotonicNow() + current.timeoutMs;
        task.evidence.push(evidence('task_recovery', 'info', 'Recovered interrupted action record(s), refreshed the active execution deadline, and preserved step/attempt budgets.', { count: interrupted }));
        await this.#persistRunState(task, assertLease);
      }
      if (this.#monotonicNow() >= activeDeadline) return await this.#fail(task, 'TASK_TIMEOUT', 'Task execution exceeded its bounded active deadline.', assertLease);
      if (current.plannerId === 'operator.semantic.v1'
        && current.plannerState.phase !== 'complete'
        && current.plannerState.phase !== 'physical-complete') {
        const outcomeTruth = verifyGoalOutcomeTruth(task);
        if (outcomeTruth.supported && outcomeTruth.ok) {
          const priorPhase = String(current.plannerState.phase ?? 'start');
          current.plannerState.phase = 'complete';
          task.evidence.push(evidence('early_outcome_completion', 'pass', 'Stopped before another environment action because the typed goal outcome is already proven true by durable machine state.', {
            goalKind: current.goalKind,
            priorPhase,
            supportingStateVersions: outcomeTruth.stateVersions
          }));
          await this.#persistRunState(task, assertLease);
        }
      }
      current.plannerIterations = (current.plannerIterations ?? 0) + 1;
      const context: TaskPlannerContext = {
        task,
        goal,
        budget: {
          maxSteps: current.maxSteps,
          usedSteps: current.stepCount,
          remainingSteps: Math.max(0, current.maxSteps - current.stepCount),
          plannerIterations: current.plannerIterations ?? 0,
          preDispatchReobserves: current.preDispatchReobserves ?? 0,
          dispatchedActions: current.dispatchedActions ?? current.stepCount,
          maxAttemptsPerStep: current.maxAttemptsPerStep,
          activeDeadlineMsRemaining: Math.max(0, Math.floor(activeDeadline - this.#monotonicNow()))
        }
      };
      let decision: PlannerDecision;
      let rawDecision: unknown;
      try {
        rawDecision = planner.next(context);
        decision = validatePlannerDecision(rawDecision);
      } catch (error) {
        const issue = error instanceof Error ? error.message : String(error);
        if (!planner.repair) return await this.#fail(task, 'TASK_PLANNER_FAILED', issue, assertLease);
        try {
          decision = validatePlannerDecision(planner.repair(context, rawDecision, issue));
          task.evidence.push(evidence('planner_repair', 'info', 'Planner repaired one malformed typed decision before execution.', {
            plannerId: planner.id,
            issue,
            remainingSteps: context.budget.remainingSteps
          }));
        } catch (repairError) {
          return await this.#fail(task, 'TASK_PLANNER_FAILED', repairError instanceof Error ? repairError.message : String(repairError), assertLease);
        }
      }
      if (decision.type === 'complete') {
        const verification = verifyTaskCompletion(task);
        task.evidence.push(verification.evidence);
        if (!verification.ok) {
          return await this.#fail(task, 'TASK_INDEPENDENT_VERIFICATION_FAILED', 'Independent completion verification rejected the task graph.', assertLease);
        }
        task.evidence.push(evidence('task_completion', 'pass', decision.message, { verificationDigest: verification.bundle.digest }));
        finalizeTask(task);
        await this.#persistRunState(task, assertLease);
        return task;
      }
      if (current.stepCount >= current.maxSteps) return await this.#fail(task, 'TASK_STEP_BUDGET_EXHAUSTED', 'Task execution exhausted its bounded step budget.', assertLease);

      const inputHash = sha256(canonicalJson(decision.input));
      const previous = [...current.records].reverse().find((record) => record.stepKey === decision.key && record.inputHash === inputHash);
      const recoveryReplay = previous?.state === 'STARTED' ? previous : undefined;
      if (!recoveryReplay && detectPlannerLoop(current.records, decision.key, inputHash)) {
        return await this.#fail(task, 'TASK_LOOP_DETECTED', `Planner repeated the ${decision.key} cycle without progress.`, assertLease);
      }
      const priorAttempts = current.records.filter((record) =>
        record.stepKey === decision.key && record.inputHash === inputHash && record.state !== 'BLOCKED' && record.state !== 'STARTED'
      ).length;
      if (!recoveryReplay && priorAttempts >= current.maxAttemptsPerStep) return await this.#fail(task, 'TASK_RETRY_BUDGET_EXHAUSTED', `Step ${decision.key} exhausted its retry budget.`, assertLease);
      let risk: ActionRisk;
      try { risk = await this.#canonicalRisk(decision.capability, decision.input); }
      catch (error) { return await this.#fail(task, 'TASK_RISK_RESOLUTION_FAILED', error instanceof Error ? error.message : String(error), assertLease); }
      const blockedReplay = previous?.state === 'BLOCKED' ? previous : undefined;
      const replayRecord = blockedReplay ?? recoveryReplay;
      const attempt = replayRecord?.attempt ?? priorAttempts + 1;
      const actionId = replayRecord?.actionId ?? deterministicActionId(task.id, decision.key, attempt, inputHash);
      const executionNodeKey = stableTaskExecutionNodeKey(decision.key, attempt, inputHash);
      const priorNode = [...task.nodes].reverse().find((candidate) => candidate.state === 'VERIFIED' || candidate.state === 'SKIPPED');
      let node = task.nodes.find((candidate) => candidate.key === executionNodeKey || candidate.actionId === actionId);
      if (!node) {
        const legacyNode = task.nodes.find((candidate) => candidate.key === undefined && candidate.title === decision.title);
        if (legacyNode) {
          legacyNode.key = executionNodeKey;
          legacyNode.stepKey = decision.key;
          legacyNode.actionId = actionId;
          if (legacyNode.dependsOn.length === 0 && priorNode && priorNode.id !== legacyNode.id) legacyNode.dependsOn = [priorNode.id];
          node = legacyNode;
          task.evidence.push(evidence('task_graph_migration', 'info', 'Migrated a legacy title-only task node to deterministic execution identity.', { stepKey: decision.key, actionId }));
        }
      }
      node ??= addTaskNode(task, decision.title, {
        key: executionNodeKey,
        stepKey: decision.key,
        actionId,
        dependsOn: priorNode ? [priorNode.id] : []
      });
      setNodeState(task, node.id, 'RUNNING');
      const record: TaskActionRecord = replayRecord ?? {
        stepKey: decision.key, actionId, capability: decision.capability, risk, inputHash, attempt,
        state: 'STARTED', startedAt: new Date().toISOString(), evidence: []
      };
      if (!replayRecord) current.records.push(record);
      else {
        record.state = 'STARTED';
        record.startedAt = new Date().toISOString();
        delete record.finishedAt;
        delete record.errorCode;
        delete record.sideEffectState;
        delete record.executionPhase;
        delete record.observation;
        record.evidence = [];
      }
      const preDispatchControl = await this.#persistRunState(task, assertLease);
      if (preDispatchControl === 'PAUSED') {
        current.records = current.records.filter((candidate) => candidate !== record);
        setNodeState(task, node.id, 'PENDING');
        await this.#persistRunState(task, assertLease);
        return task;
      }
      if (preDispatchControl === 'CANCELLED') {
        record.state = 'INTERRUPTED';
        record.finishedAt = new Date().toISOString();
        record.errorCode = 'EXECUTION_ABORTED';
        record.sideEffectState = 'none';
        record.executionPhase = 'pre_dispatch';
        setNodeState(task, node.id, 'SKIPPED');
        task.evidence.push(evidence('task_cancel', 'info', 'Task was cancelled before provider dispatch.'));
        await this.#persistRunState(task, assertLease);
        return task;
      }

      const action: ActionRequest = {
        id: actionId, taskId: task.id, capability: decision.capability, risk,
        input: structuredClone(decision.input), provenance: { kind: 'trusted_policy', source: `task-planner:${planner.id}` },
        ...(decision.target ? { target: decision.target } : {}),
        ...(task.intent ? { intent: task.intent } : {})
      };
      const basePermissions = authorization.permissionProvider
        ? await authorization.permissionProvider(action)
        : this.#permissions;
      const permissions = approvedActionIds.length === 0 ? basePermissions : {
        ...basePermissions,
        approvedActionIds: [...new Set([...(basePermissions.approvedActionIds ?? []), ...approvedActionIds])]
      };
      const learningContext = semanticLearningContext(goal, task);
      let result: ActionResult | undefined;
      let resourceLease: Awaited<ReturnType<ResourceLeaseStore['acquire']>> | undefined;
      let executionDispatched = false;
      try {
        if (this.#resourceLeases) {
          resourceLease = await this.#resourceLeases.acquire(
            task.id,
            resourceKeysForAction(action),
            risk === 'read' ? 'shared' : 'exclusive'
          );
        }
        executionDispatched = true;
        result = await this.#executeAction(action, permissions, { signal, learningContext });
      } catch (error) {
        const code = error instanceof OperatorError ? error.code : 'TASK_EXECUTOR_EXCEPTION';
        result = {
          ok: false,
          capability: action.capability,
          provider: code === 'RESOURCE_BUSY' ? 'scheduler' : 'task-executor',
          evidence: [],
          durationMs: 0,
          error: {
            code,
            message: error instanceof Error ? error.message : String(error),
            retryable: error instanceof OperatorError ? error.retryable : false,
            sideEffectState: executorExceptionSideEffectState(risk, error, executionDispatched),
            executionPhase: executorExceptionExecutionPhase(error, executionDispatched)
          }
        };
      } finally {
        if (resourceLease) {
          try {
            await resourceLease.release();
          } catch (error) {
            const priorResult = result;
            result = {
              ok: false,
              capability: action.capability,
              provider: 'scheduler',
              evidence: priorResult?.evidence ?? [],
              durationMs: priorResult?.durationMs ?? 0,
              error: {
                code: 'RESOURCE_LEASE_RELEASE_FAILED',
                message: error instanceof Error ? error.message : String(error),
                retryable: false,
                sideEffectState: risk === 'read' ? 'none' : priorResult?.ok ? 'known' : (priorResult?.error?.sideEffectState ?? 'uncertain'),
                executionPhase: priorResult ? conservativeExecutionPhase(priorResult) : executionDispatched ? 'dispatched' : 'pre_dispatch'
              }
            };
          }
        }
      }
      if (!result) {
        result = {
          ok: false,
          capability: action.capability,
          provider: 'task-executor',
          evidence: [],
          durationMs: 0,
          error: {
            code: 'TASK_EXECUTOR_RESULT_MISSING',
            message: 'Task action completed without a durable execution result.',
            retryable: false,
            sideEffectState: executionDispatched && risk !== 'read' ? 'uncertain' : 'none',
            executionPhase: executionDispatched ? 'dispatched' : 'pre_dispatch'
          }
        };
      }
      if (authorization.onActionResult) {
        try {
          await authorization.onActionResult(action, result);
        } catch (error) {
          result = {
            ok: false,
            capability: action.capability,
            provider: 'approval',
            evidence: result.evidence,
            durationMs: result.durationMs,
            error: {
              code: 'APPROVAL_SETTLEMENT_FAILED',
              message: error instanceof Error ? error.message : String(error),
              retryable: false,
              sideEffectState: result.ok ? 'known' : (result.error?.sideEffectState ?? 'uncertain'),
              executionPhase: conservativeExecutionPhase(result)
            }
          };
        }
      }
      const latest = await this.#store.get(task.id);
      await assertLease();
      const controlState = latest.state === 'PAUSED' || latest.state === 'CANCELLED'
        ? latest.state
        : this.#controlRequests.get(taskId);
      task = latest;
      const latestExecution = task.execution!;
      const resultExecutionPhase = conservativeExecutionPhase(result);
      if (resultExecutionPhase !== 'pre_dispatch') {
        const dispatchedBefore = latestExecution.dispatchedActions ?? latestExecution.stepCount;
        latestExecution.stepCount += 1;
        latestExecution.dispatchedActions = dispatchedBefore + 1;
      }
      const postActionContext: TaskPlannerContext = {
        task,
        goal,
        budget: {
          maxSteps: latestExecution.maxSteps,
          usedSteps: latestExecution.stepCount,
          remainingSteps: Math.max(0, latestExecution.maxSteps - latestExecution.stepCount),
          plannerIterations: latestExecution.plannerIterations ?? 0,
          preDispatchReobserves: latestExecution.preDispatchReobserves ?? 0,
          dispatchedActions: latestExecution.dispatchedActions ?? latestExecution.stepCount,
          maxAttemptsPerStep: latestExecution.maxAttemptsPerStep,
          activeDeadlineMsRemaining: Math.max(0, Math.floor(activeDeadline - this.#monotonicNow()))
        }
      };
      const latestRecord = latestExecution.records.find((candidate) => candidate.actionId === actionId);
      if (!latestRecord) return await this.#fail(task, 'TASK_STATE_CONFLICT', 'Persisted action record disappeared during execution.', assertLease);
      const latestNode = task.nodes.find((candidate) => candidate.key === executionNodeKey || candidate.actionId === actionId)
        ?? task.nodes.find((candidate) => candidate.title === decision.title);
      if (!latestNode) return await this.#fail(task, 'TASK_STATE_CONFLICT', 'Persisted task node disappeared during execution.', assertLease);
      const observation = observe(result);
      const normalizedObservation = normalizeMachineObservation(action, result, observation.channel);
      latestRecord.finishedAt = new Date().toISOString();
      latestRecord.evidence = result.evidence;
      latestRecord.sideEffectState = conservativeSideEffectState(risk, result);
      latestRecord.executionPhase = resultExecutionPhase;
      latestRecord.observation = normalizedObservation;
      latestNode.evidence.push(...result.evidence);
      task.evidence.push(...result.evidence);
      if (result.ok) {
        try {
          planner.accept(postActionContext, decision, observation);
        } catch (error) {
          await this.#recordLearning(task, result, 'failed', learningContext);
          const postconditionCode = error instanceof OperatorError ? error.code : 'TASK_POSTCONDITION_FAILED';
          const postconditionMessage = error instanceof Error ? error.message : String(error);
          const postconditionObservation: TaskObservation = {
            ...observation,
            ok: false,
            error: { code: postconditionCode, message: postconditionMessage, retryable: false }
          };
          const failureDecision = classifyTaskFailure(postconditionObservation.error);
          task.evidence.push(evidence('failure_classification', 'info', 'Classified semantic postcondition failure before repair decision.', {
            code: failureDecision.code,
            class: failureDecision.class,
            strategy: failureDecision.strategy,
            capability: result.capability
          }));
          if (planner.fallback?.(postActionContext, decision, postconditionObservation)) {
            latestRecord.state = 'FAILED';
            latestRecord.errorCode = postconditionCode;
            setNodeState(task, latestNode.id, 'SKIPPED');
            await this.#persistRunState(task, assertLease);
            continue;
          }
          latestRecord.state = 'FAILED';
          latestRecord.errorCode = 'TASK_POSTCONDITION_FAILED';
          setNodeState(task, latestNode.id, 'FAILED');
          return await this.#fail(task, 'TASK_POSTCONDITION_FAILED', postconditionMessage, assertLease);
        }
        await this.#recordLearning(task, result, 'verified', learningContext);
        latestRecord.state = 'SUCCEEDED';
        setNodeState(task, latestNode.id, 'VERIFIED');
        if (controlState) task.state = controlState;
        await this.#persistRunState(task, assertLease);
        if (controlState) return task;
        continue;
      }

      latestRecord.errorCode = result.error?.code ?? 'EXECUTION_FAILED';
      const failureDecision = classifyTaskFailure(result.error);
      task.evidence.push(evidence('failure_classification', 'info', 'Classified failed task action before choosing recovery strategy.', {
        code: failureDecision.code,
        class: failureDecision.class,
        strategy: failureDecision.strategy,
        capability: result.capability
      }));
      if (controlState === 'CANCELLED' && latestRecord.errorCode === 'EXECUTION_ABORTED') {
        latestRecord.state = 'INTERRUPTED';
        setNodeState(task, latestNode.id, 'SKIPPED');
        task.evidence.push(evidence('task_cancel', 'info', 'In-flight task execution was aborted after cancellation.'));
        task.state = 'CANCELLED';
        await this.#persistRunState(task, assertLease);
        return task;
      }
      if (latestRecord.errorCode === 'APPROVAL_REQUIRED') {
        const remainingMs = Math.max(0, activeDeadline - this.#monotonicNow());
        const approvalOutcome = await authorization.onApprovalRequired?.(action, remainingMs);
        if (approvalOutcome === 'retry') {
          latestRecord.state = 'BLOCKED';
          setNodeState(task, latestNode.id, 'BLOCKED');
          task.state = 'RUNNING';
          await this.#persistRunState(task, assertLease);
          continue;
        }
        if (approvalOutcome === 'deny') {
          latestRecord.state = 'FAILED';
          latestRecord.errorCode = 'APPROVAL_DENIED';
          setNodeState(task, latestNode.id, 'FAILED');
          return await this.#fail(task, 'TASK_APPROVAL_DENIED', 'The local user denied a required task action.', assertLease);
        }
        latestRecord.state = 'BLOCKED';
        task.state = 'BLOCKED';
        setNodeState(task, latestNode.id, 'BLOCKED');
        await this.#persistRunState(task, assertLease);
        return task;
      }
      await this.#recordLearning(task, result, 'failed', learningContext);
      if (planner.fallback?.(postActionContext, decision, observation)) {
        latestRecord.state = 'FAILED';
        setNodeState(task, latestNode.id, 'SKIPPED');
        if (controlState) task.state = controlState;
        await this.#persistRunState(task, assertLease);
        if (controlState) return task;
        continue;
      }
      latestRecord.state = 'FAILED';
      setNodeState(task, latestNode.id, 'FAILED');
      if (controlState) {
        task.state = controlState;
        await this.#persistRunState(task, assertLease);
        return task;
      }
      const retrySafe = retrySafeWithoutReconciliation(risk, latestRecord.sideEffectState ?? 'uncertain');
      if (failureDecision.retryable && retrySafe && failureDecision.strategy === 'reobserve'
        && (risk === 'read' || latestRecord.executionPhase === 'pre_dispatch')) {
        setNodeState(task, latestNode.id, 'SKIPPED');
        latestExecution.records = latestExecution.records.filter((candidate) => candidate !== latestRecord);
        latestExecution.preDispatchReobserves = (latestExecution.preDispatchReobserves ?? 0) + 1;
        task.evidence.push(evidence('strategy_reobserve', 'info', 'Superseded a pre-dispatch stale-state attempt and returned control for fresh observation without charging an environment-action step.', {
          code: failureDecision.code,
          class: failureDecision.class,
          strategy: failureDecision.strategy,
          actionId: latestRecord.actionId,
          sideEffectState: latestRecord.sideEffectState ?? 'none',
          executionPhase: latestRecord.executionPhase ?? 'pre_dispatch'
        }));
        await this.#persistRunState(task, assertLease);
        continue;
      }
      if (failureDecision.retryable && retrySafe && failureDecision.strategy === 'repair') {
        setNodeState(task, latestNode.id, 'SKIPPED');
        task.evidence.push(evidence('strategy_repair', 'info', 'Returned control to the planner after a proven no-side-effect target/precondition drift so it can deterministically repair the next action.', {
          code: failureDecision.code,
          class: failureDecision.class,
          actionId: latestRecord.actionId,
          executionPhase: latestRecord.executionPhase ?? 'pre_dispatch'
        }));
        await this.#persistRunState(task, assertLease);
        continue;
      }
      if (failureDecision.strategy === 'reconcile') {
        latestRecord.state = 'BLOCKED';
        setNodeState(task, latestNode.id, 'BLOCKED');
        task.state = 'BLOCKED';
        task.evidence.push(evidence('strategy_reconcile', 'info', 'Paused automatic execution because dispatch may have occurred and side effects are uncertain; durable reconciliation is required before retry.', {
          code: failureDecision.code,
          class: failureDecision.class,
          actionId: latestRecord.actionId,
          risk,
          sideEffectState: latestRecord.sideEffectState ?? 'uncertain',
          executionPhase: latestRecord.executionPhase ?? 'dispatched'
        }));
        await this.#persistRunState(task, assertLease);
        return task;
      }
      if (failureDecision.retryable && retrySafe && failureDecision.strategy === 'retry') {
        setNodeState(task, latestNode.id, 'SKIPPED');
        task.evidence.push(evidence('strategy_retry', 'info', 'Scheduled a bounded retry because the failed attempt is proven safe to retry under the same authority boundary.', {
          code: failureDecision.code,
          class: failureDecision.class,
          strategy: failureDecision.strategy,
          actionId: latestRecord.actionId
        }));
        await this.#persistRunState(task, assertLease);
        continue;
      }
      if (failureDecision.retryable && !retrySafeWithoutReconciliation(risk, latestRecord.sideEffectState ?? 'uncertain')) {
        task.evidence.push(evidence('strategy_fail_closed', 'info', 'Refused blind retry because side effects are known or uncertain; recovery requires explicit re-observation/reconciliation.', {
          code: failureDecision.code,
          class: failureDecision.class,
          strategy: failureDecision.strategy,
          risk,
          sideEffectState: latestRecord.sideEffectState ?? 'uncertain'
        }));
      }
      return await this.#fail(task, latestRecord.errorCode, result.error?.message ?? 'Task action failed.', assertLease);
    }
  }

  async pause(taskId: string): Promise<TaskCapsule> { return await this.#requestControl(taskId, 'PAUSED'); }
  async cancel(taskId: string): Promise<TaskCapsule> {
    return await this.#requestControl(taskId, 'CANCELLED');
  }
  async resume(taskId: string, approvedActionIds: string[] = [], authorization: TaskRunAuthorization = {}): Promise<TaskCapsule> {
    const active = this.#active.get(taskId);
    if (active) await active;
    await this.#withStateWriteLock(taskId, async () => {
      const task = await this.#store.get(taskId);
      if (this.#controlRequests.get(taskId) === 'CANCELLED') {
        throw new OperatorError('TASK_TERMINAL', 'Task cancellation is already in progress.');
      }
      if (!['PAUSED', 'BLOCKED'].includes(task.state)) throw new OperatorError('TASK_NOT_RESUMABLE', 'Only paused or blocked tasks can resume.');
      if (this.#controlRequests.get(taskId) === 'PAUSED') this.#controlRequests.delete(taskId);
      task.state = 'PENDING';
      for (const node of task.nodes) if (node.state === 'BLOCKED') node.state = 'PENDING';
      if (task.execution?.startedAt) {
        task.execution.deadlineAt = new Date(this.#wallNow() + task.execution.timeoutMs).toISOString();
        task.evidence.push(evidence('task_resume', 'info', 'Resumed task with a fresh active execution deadline; step and attempt budgets were preserved.'));
      }
      await this.#store.put(task);
    });
    return await this.run(taskId, approvedActionIds, authorization);
  }

  async #setControlState(taskId: string, state: 'PAUSED' | 'CANCELLED'): Promise<TaskCapsule> {
    const previous = this.#controlRequests.get(taskId);
    this.#controlRequests.set(taskId, state);
    try {
      return await this.#withStateWriteLock(taskId, async () => {
        const task = await this.#store.get(taskId);
        if (task.state === state) {
          if (!this.#active.has(taskId)) this.#controlRequests.delete(taskId);
          return task;
        }
        if (['VERIFIED', 'FAILED', 'CANCELLED'].includes(task.state)) throw new OperatorError('TASK_TERMINAL', 'Terminal task state cannot change.');
        task.state = state;
        task.updatedAt = new Date().toISOString();
        await this.#store.put(task);
        if (!this.#active.has(taskId)) this.#controlRequests.delete(taskId);
        return task;
      });
    } catch (error) {
      if (previous) this.#controlRequests.set(taskId, previous);
      else this.#controlRequests.delete(taskId);
      throw error;
    }
  }

  async #requestControl(taskId: string, state: 'PAUSED' | 'CANCELLED'): Promise<TaskCapsule> {
    const active = this.#active.get(taskId);
    if (!active) return await this.#setControlState(taskId, state);
    const previous = this.#controlRequests.get(taskId);
    this.#controlRequests.set(taskId, state);
    if (state === 'CANCELLED') this.#controllers.get(taskId)?.abort();
    try {
      // A terminal/paused state is not returned until the active provider has
      // settled and the runner has durably recorded its side-effect truth.
      return await active;
    } catch (error) {
      if (previous) this.#controlRequests.set(taskId, previous);
      else this.#controlRequests.delete(taskId);
      throw error;
    }
  }

  #applyControlRequest(task: TaskCapsule): 'PAUSED' | 'CANCELLED' | undefined {
    const requested = this.#controlRequests.get(task.id);
    if (requested === 'CANCELLED') {
      task.state = 'CANCELLED';
      return 'CANCELLED';
    }
    if (requested === 'PAUSED' && !['VERIFIED', 'FAILED', 'CANCELLED'].includes(task.state)) {
      task.state = 'PAUSED';
      return 'PAUSED';
    }
    return undefined;
  }

  async #persistRunState(task: TaskCapsule, assertLease: () => Promise<void>): Promise<'PAUSED' | 'CANCELLED' | undefined> {
    await this.#withStateWriteLock(task.id, async () => {
      this.#applyControlRequest(task);
      await assertLease();
      await this.#store.put(task);
    });
    // Control intent is published before its serialized durable write. Re-apply
    // synchronously so the runner cannot dispatch work while that write waits.
    return this.#applyControlRequest(task);
  }

  async #withStateWriteLock<T>(taskId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#stateWriteTails.get(taskId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.#stateWriteTails.set(taskId, tail);
    await previous.catch(() => undefined);
    try {
      return await work();
    } finally {
      release();
      if (this.#stateWriteTails.get(taskId) === tail) this.#stateWriteTails.delete(taskId);
    }
  }

  async #canonicalRisk(capability: string, input: Record<string, unknown>): Promise<ActionRisk> {
    const rule = capabilityRiskRule(capability);
    if (rule !== 'dynamic') return rule;
    return await this.#runtime.router.resolveRisk({ id: 'task-risk-probe', capability, risk: 'read', input, provenance: { kind: 'trusted_policy' } });
  }

  async #recordLearning(task: TaskCapsule, result: ActionResult, outcome: 'verified' | 'failed', learningContext: string): Promise<void> {
    try {
      const recorded = await this.#runtime.router.recordOutcome(result.capability, result.provider, outcome, { context: learningContext, durationMs: result.durationMs });
      if (recorded) {
        task.evidence.push(evidence('adaptive_learning', 'info', 'Recorded a bounded provider outcome for future routing.', {
          capability: result.capability,
          provider: result.provider,
          outcome
        }));
      }
    } catch (error) {
      const code = error instanceof OperatorError ? error.code : 'PROVIDER_LEARNING_UPDATE_FAILED';
      task.evidence.push(evidence('adaptive_learning', 'fail', 'Provider learning update could not be persisted; the current action result remains authoritative.', { code }));
    }
  }

  async #markInterrupted(task: TaskCapsule): Promise<number> {
    const execution = task.execution;
    if (!execution) return 0;
    let count = 0;
    for (const record of execution.records) if (record.state === 'STARTED') {
      if (this.#actionJournal) {
        try {
          const entry = await this.#actionJournal.inspect(record.actionId);
          record.evidence.push(evidence(
            'task_recovery_journal',
            'info',
            'Preserved the original action identity for crash recovery through the central transition journal.',
            { actionId: record.actionId, journalState: entry.state }
          ));
          count += 1;
          continue;
        } catch (error) {
          if (!(error instanceof OperatorError) || error.code !== 'ACTION_JOURNAL_NOT_FOUND') throw error;
        }
      }
      record.state = 'INTERRUPTED';
      record.finishedAt = new Date().toISOString();
      record.errorCode = 'TASK_ACTION_INTERRUPTED';
      record.sideEffectState = record.risk === 'read' ? 'none' : 'uncertain';
      if (record.executionPhase === undefined) {
        record.executionPhase = 'dispatched';
        const dispatchedBefore = execution.dispatchedActions ?? execution.stepCount;
        execution.stepCount = Math.min(execution.maxSteps, execution.stepCount + 1);
        execution.dispatchedActions = Math.min(execution.maxSteps, dispatchedBefore + 1);
      }
      const node = task.nodes.find((candidate) => candidate.actionId === record.actionId);
      if (node && (node.state === 'RUNNING' || node.state === 'PENDING' || node.state === 'BLOCKED')) {
        node.state = 'SKIPPED';
        node.evidence.push(evidence('task_recovery', 'info', 'Interrupted execution attempt was superseded during recovery.', {
          actionId: record.actionId,
          stepKey: record.stepKey
        }));
      }
      count += 1;
    }
    if (count > 0) task.updatedAt = new Date().toISOString();
    return count;
  }

  async #fail(task: TaskCapsule, code: string, message: string, assertLease?: () => Promise<void>): Promise<TaskCapsule> {
    task.state = 'FAILED';
    task.failures.push({ at: new Date().toISOString(), code, message });
    task.evidence.push(evidence('task_failure', 'fail', message, { code }));
    task.updatedAt = new Date().toISOString();
    if (assertLease) await this.#persistRunState(task, assertLease);
    else await this.#store.put(task);
    return task;
  }
}

function executorExceptionExecutionPhase(error: unknown, dispatched: boolean): ExecutionPhase {
  if (error instanceof OperatorError && error.details?.executionPhase !== undefined) {
    try { return validExecutionPhase(error.details.executionPhase); } catch { /* fail closed below */ }
  }
  return dispatched ? 'dispatched' : 'pre_dispatch';
}

function executorExceptionSideEffectState(risk: ActionRisk, error: unknown, dispatched: boolean): SideEffectState {
  if (risk === 'read' || !dispatched) return 'none';
  if (error instanceof OperatorError && error.details?.sideEffectState !== undefined) {
    try { return validSideEffectState(error.details.sideEffectState); } catch { /* fail closed below */ }
  }
  return 'uncertain';
}

export class ProjectQualityGatePlanner implements TaskPlanner {
  readonly id = 'operator.project-quality-gate.v1';

  supports(goal: SemanticTaskGoal): boolean { return goal.kind === 'project-quality-gate'; }

  next({ task, goal }: TaskPlannerContext): PlannerDecision {
    if (goal.kind !== 'project-quality-gate') throw new OperatorError('TASK_GOAL_INVALID', 'Project quality planner requires a project-quality-gate goal.');
    const state = task.execution!.plannerState;
    const phase = String(state.phase ?? 'start');
    if (phase === 'start') {
      return { type: 'step', key: 'quality-inspect-project', title: 'Inspect project before compiling quality gate', capability: 'project.inspect', input: { path: goal.root }, target: goal.root };
    }
    if (phase === 'commands') {
      return { type: 'step', key: 'quality-inspect-commands', title: 'Discover trusted quality checks', capability: 'project.command.inspect', input: { path: goal.root }, target: goal.root };
    }
    if (phase === 'run') {
      const checks = Array.isArray(state.qualityChecks) ? state.qualityChecks.map(asRecord) : [];
      const index = Number(state.qualityIndex ?? 0);
      if (!Number.isSafeInteger(index) || index < 0 || index > checks.length) throw new OperatorError('TASK_QUALITY_GATE_STATE_INVALID', 'Quality gate check index is invalid.');
      if (index >= checks.length) return { type: 'complete', message: `Project quality gate completed ${checks.length} trusted check(s).` };
      const current = checks[index]!;
      const kind = String(current.kind ?? '');
      const commandId = String(current.id ?? '');
      const risk = String(current.risk ?? '');
      if (!['lint', 'test', 'build'].includes(kind) || !commandId || !['read', 'write', 'external'].includes(risk)) {
        throw new OperatorError('TASK_QUALITY_GATE_STATE_INVALID', 'Compiled quality gate contains an invalid trusted command.');
      }
      if (risk === 'external') {
        throw new OperatorError('TASK_QUALITY_GATE_IRREVERSIBLE_CHECK', `Trusted ${kind} check is external and cannot be safely rolled back by the autonomous quality gate.`);
      }
      return {
        type: 'step', key: `quality-run:${index}:${kind}`, title: `Run trusted ${kind} quality check`,
        capability: risk === 'write' ? 'project.transaction.run' : 'project.command.run',
        input: { path: goal.root, commandId, expectedRisk: risk }, target: goal.root
      };
    }
    return { type: 'complete', message: 'Project quality gate satisfied its compiled trusted checks.' };
  }

  accept({ task, goal }: TaskPlannerContext, step: Extract<PlannerDecision, { type: 'step' }>, result: TaskObservation): void {
    if (goal.kind !== 'project-quality-gate') throw new OperatorError('TASK_GOAL_INVALID', 'Project quality planner requires a project-quality-gate goal.');
    const state = task.execution!.plannerState;
    if (step.key === 'quality-inspect-project') {
      state.phase = 'commands';
      return;
    }
    if (step.key === 'quality-inspect-commands') {
      const output = asRecord(result.output);
      const commands = Array.isArray(output.commands) ? output.commands.map(asRecord) : [];
      const requested = goal.checks ?? ['lint', 'test', 'build'];
      const selected: Array<{ kind: ProjectQualityCheck; id: string; risk: string }> = [];
      const missing: ProjectQualityCheck[] = [];
      for (const kind of requested) {
        const command = commands.find((candidate) => candidate.kind === kind);
        const id = String(command?.id ?? '');
        const risk = String(command?.risk ?? '');
        if (!command || !id || !['read', 'write', 'external'].includes(risk)) missing.push(kind);
        else if (risk === 'external') {
          task.evidence.push(evidence('goal_compilation', 'fail', `Trusted ${kind} check is external and is not eligible for autonomous rollback-safe execution.`, { commandId: id }));
          missing.push(kind);
        } else selected.push({ kind, id, risk });
      }
      if (goal.requireAll && missing.length > 0) {
        task.evidence.push(evidence('goal_compilation', 'fail', 'Required trusted quality checks are unavailable.', { code: 'TASK_QUALITY_GATE_REQUIRED_CHECK_MISSING', missing }));
        throw new OperatorError('TASK_QUALITY_GATE_REQUIRED_CHECK_MISSING', `Required trusted quality checks are unavailable: ${missing.join(', ')}.`);
      }
      if (selected.length === 0) {
        task.evidence.push(evidence('goal_compilation', 'fail', 'No requested trusted quality checks are configured.', { code: 'TASK_QUALITY_GATE_EMPTY', requested }));
        throw new OperatorError('TASK_QUALITY_GATE_EMPTY', 'No requested trusted lint, test, or build command is configured for this project.');
      }
      state.qualityChecks = selected;
      state.missingChecks = missing;
      state.qualityIndex = 0;
      state.phase = 'run';
      task.evidence.push(evidence('goal_compilation', 'pass', `Compiled project quality goal into ${selected.length} trusted check(s).`, { checks: selected.map((item) => item.kind) }));
      if (missing.length > 0) task.evidence.push(evidence('goal_compilation', 'info', 'Skipped unavailable optional quality checks.', { missing }));
      return;
    }
    if (step.key.startsWith('quality-run:')) {
      const checks = Array.isArray(state.qualityChecks) ? state.qualityChecks.map(asRecord) : [];
      const index = Number(state.qualityIndex ?? 0);
      const current = checks[index];
      if (!current || step.key !== `quality-run:${index}:${String(current.kind ?? '')}`) {
        throw new OperatorError('TASK_QUALITY_GATE_STATE_INVALID', 'Quality gate action does not match the compiled check state.');
      }
      task.evidence.push(evidence('quality_check', 'pass', `Trusted ${String(current.kind)} check completed.`, { commandId: String(current.id ?? '') }));
      state.qualityIndex = index + 1;
      if (index + 1 >= checks.length) state.phase = 'complete';
    }
  }
}

export class SemanticTaskPlanner implements TaskPlanner {
  readonly id = 'operator.semantic.v1';
  supports(goal: SemanticTaskGoal): boolean { return ['controlled-file-change', 'trusted-project-command', 'browser-navigation', 'docker-lifecycle', 'postgres-select', 'app-operation'].includes(goal.kind); }

  next({ task, goal }: TaskPlannerContext): PlannerDecision {
    if (goal.kind === 'semantic-workflow') throw new OperatorError('TASK_GOAL_INVALID', 'Atomic semantic planner cannot execute a workflow envelope.');
    if (goal.kind === 'project-quality-gate') throw new OperatorError('TASK_GOAL_INVALID', 'Atomic semantic planner cannot execute a project quality gate envelope.');
    const state = task.execution!.plannerState;
    const phase = String(state.phase ?? 'start');
    if (goal.kind === 'controlled-file-change') {
      if (phase === 'start') return { type: 'step', key: 'list-parent', title: 'Observe target directory', capability: 'file.list', input: { path: path.dirname(goal.path) || '.' } };
      if (phase === 'create') return { type: 'step', key: 'create-file', title: 'Create requested file', capability: 'file.create', input: { path: goal.path, content: goal.content } };
      if (phase === 'read') return { type: 'step', key: 'verify-file', title: 'Verify exact file content', capability: 'file.read', input: { path: goal.path, encoding: 'utf8' } };
      if (phase === 'repair') return {
        type: 'step', key: 'repair-file', title: 'Repair stale file content with SHA precondition',
        capability: 'file.replace', input: { path: goal.path, content: goal.content, expectedSha256: state.expectedSha256 }
      };
      if (phase === 'git') return { type: 'step', key: 'inspect-git', title: 'Verify Git observes the file', capability: 'git.status', input: { cwd: goal.root } };
      return { type: 'complete', message: 'Controlled file task satisfied exact-content and Git-state postconditions.' };
    }
    if (goal.kind === 'trusted-project-command') {
      if (phase === 'start') return { type: 'step', key: 'inspect-project', title: 'Inspect project semantics', capability: 'project.inspect', input: { path: goal.root } };
      if (phase === 'commands') return { type: 'step', key: 'inspect-commands', title: 'Discover trusted project commands', capability: 'project.command.inspect', input: { path: goal.root } };
      if (phase === 'run') return { type: 'step', key: 'run-command', title: 'Execute trusted project command', capability: 'project.command.run', input: { path: goal.root, commandId: state.commandId, expectedRisk: state.commandRisk } };
      return { type: 'complete', message: 'Trusted project command completed with its registered postcondition validation.' };
    }
    if (goal.kind === 'docker-lifecycle') {
      if (phase === 'start') return { type: 'step', key: 'inspect-docker-project', title: 'Inspect Docker project state', capability: 'docker.inspect', input: { path: goal.root }, target: goal.root };
      if (phase === 'manage') return {
        type: 'step', key: 'manage-docker-services', title: 'Manage verified Docker services', capability: 'docker.manage',
        input: {
          path: goal.root, operation: goal.operation, services: goal.services,
          expectedCurrentFingerprint: state.dockerFingerprint, timeoutMs: goal.timeoutMs ?? 60_000
        },
        target: goal.root
      };
      if (phase === 'verify') return { type: 'step', key: 'verify-docker-project', title: 'Re-inspect Docker lifecycle postcondition', capability: 'docker.inspect', input: { path: goal.root }, target: goal.root };
      return { type: 'complete', message: 'Docker lifecycle operation satisfied fresh-state, approval, and semantic service-state postconditions.' };
    }
    if (goal.kind === 'postgres-select') {
      if (phase === 'start') return {
        type: 'step', key: 'inspect-postgres-profiles', title: 'Inspect trusted PostgreSQL profiles',
        capability: 'postgres.inspect', input: { path: goal.root, operation: 'profiles' }, target: goal.root
      };
      if (phase === 'columns') return {
        type: 'step', key: 'inspect-postgres-columns', title: 'Inspect PostgreSQL table columns',
        capability: 'postgres.inspect', input: {
          path: goal.root, operation: 'columns', profileId: goal.profileId,
          schema: goal.schema ?? 'public', table: goal.table, timeoutMs: goal.timeoutMs ?? 5_000
        },
        target: goal.root
      };
      if (phase === 'select') return {
        type: 'step', key: 'select-postgres-rows', title: 'Read bounded PostgreSQL rows',
        capability: 'postgres.select', input: postgresSelectActionInput(goal),
        target: goal.root
      };
      return { type: 'complete', message: 'PostgreSQL task satisfied trusted-profile, current-column, and bounded read-only SELECT postconditions.' };
    }
    if (goal.kind === 'app-operation') {
      const selector = phase === 'verify' ? (goal.verifySelector ?? goal.selector) : goal.selector;
      const inspectInput = { selector, maxNodes: 1, maxDepth: 1, waitMs: goal.waitMs ?? 0 };
      if (phase === 'start') return { type: 'step', key: 'inspect-app-target', title: 'Inspect unique semantic app target', capability: 'app.inspect', input: inspectInput };
      if (phase === 'operate') return {
        type: 'step', key: 'operate-app-target', title: 'Operate verified semantic app target', capability: 'app.operate',
        input: {
          operation: goal.operation, selector: goal.selector, waitMs: goal.waitMs ?? 0,
          ...(goal.value !== undefined ? { value: goal.value } : {}),
          ...(goal.horizontalAmount !== undefined ? { horizontalAmount: goal.horizontalAmount } : {}),
          ...(goal.verticalAmount !== undefined ? { verticalAmount: goal.verticalAmount } : {})
        }
      };
      if (phase === 'verify') return { type: 'step', key: 'verify-app-target', title: 'Re-inspect app postcondition', capability: 'app.inspect', input: inspectInput };
      if (phase === 'visual-capture') {
        const fallback = requireAppPhysicalFallback(goal);
        return {
          type: 'step', key: 'capture-app-fallback', title: 'Capture bounded visual fallback state', capability: 'visual.capture',
          input: {
            source: fallback.source,
            ...(fallback.selector ? { selector: fallback.selector } : {}),
            ...(fallback.region ? { region: fallback.region } : {}),
            maxWidth: fallback.maxWidth ?? 960,
            maxHeight: fallback.maxHeight ?? 540,
            waitMs: goal.waitMs ?? 0
          }
        };
      }
      if (phase === 'physical-operate') {
        const fallback = requireAppPhysicalFallback(goal);
        const captureId = boundedText(state.captureId, 128, 'visual fallback captureId');
        const expectedSha256 = boundedText(state.captureSha256, 64, 'visual fallback SHA-256');
        return {
          type: 'step', key: 'operate-app-physical-fallback', title: 'Operate capture-bound physical fallback', capability: 'input.operate',
          input: {
            operation: fallback.operation,
            captureId,
            expectedSha256,
            ...(fallback.x !== undefined ? { x: fallback.x } : {}),
            ...(fallback.y !== undefined ? { y: fallback.y } : {}),
            ...(fallback.toX !== undefined ? { toX: fallback.toX } : {}),
            ...(fallback.toY !== undefined ? { toY: fallback.toY } : {}),
            ...(fallback.deltaX !== undefined ? { deltaX: fallback.deltaX } : {}),
            ...(fallback.deltaY !== undefined ? { deltaY: fallback.deltaY } : {}),
            ...(fallback.text !== undefined ? { text: fallback.text } : {}),
            ...(fallback.key !== undefined ? { key: fallback.key } : {}),
            ...(fallback.keys !== undefined ? { keys: fallback.keys } : {})
          }
        };
      }
      return {
        type: 'complete',
        message: phase === 'physical-complete'
          ? 'Application operation satisfied semantic-first visual fallback with capture-bound physical input and AFTER verification.'
          : 'Application operation satisfied semantic targeting and deterministic postcondition verification.'
      };
    }
    if (phase === 'start') return { type: 'step', key: 'inspect-browser', title: 'Inspect semantic browser state', capability: 'browser.inspect', input: {} };
    if (phase === 'navigate') return { type: 'step', key: 'navigate-browser', title: 'Navigate the selected browser target', capability: 'browser.navigate', input: { targetId: state.targetId, url: goal.url }, target: goal.url };
    if (phase === 'verify') return { type: 'step', key: 'verify-browser', title: 'Verify semantic browser destination', capability: 'browser.inspect', input: { targetId: state.targetId }, target: goal.url };
    return { type: 'complete', message: 'Browser navigation satisfied semantic destination postconditions.' };
  }

  accept({ task, goal }: TaskPlannerContext, step: Extract<PlannerDecision, { type: 'step' }>, result: TaskObservation): void {
    if (goal.kind === 'semantic-workflow') throw new OperatorError('TASK_GOAL_INVALID', 'Atomic semantic planner cannot accept a workflow envelope.');
    if (goal.kind === 'project-quality-gate') throw new OperatorError('TASK_GOAL_INVALID', 'Atomic semantic planner cannot accept a project quality gate envelope.');
    const state = task.execution!.plannerState;
    if (goal.kind === 'controlled-file-change') {
      if (step.key === 'list-parent') state.phase = 'create';
      else if (step.key === 'create-file') state.phase = 'read';
      else if (step.key === 'verify-file') {
        const output = asRecord(result.output);
        if (output.content !== goal.content) throw new OperatorError('TASK_CONTENT_MISMATCH', 'File content did not match the requested exact content.');
        state.phase = 'git';
      } else if (step.key === 'repair-file') {
        state.phase = 'read';
        delete state.expectedSha256;
      } else if (step.key === 'inspect-git') {
        const entries = Array.isArray(asRecord(result.output).entries) ? asRecord(result.output).entries as Array<Record<string, unknown>> : [];
        const wanted = path.relative(goal.root, goal.path).replace(/\\/g, '/').replace(/^\.\//, '');
        if (!entries.some((entry) => String(entry.path ?? '').replace(/\\/g, '/') === wanted)) throw new OperatorError('TASK_GIT_POSTCONDITION_MISSING', 'Git status did not report the controlled file.');
        state.phase = 'complete';
      }
      return;
    }
    if (goal.kind === 'trusted-project-command') {
      if (step.key === 'inspect-project') state.phase = 'commands';
      else if (step.key === 'inspect-commands') {
        const commands = Array.isArray(asRecord(result.output).commands) ? asRecord(result.output).commands as Array<Record<string, unknown>> : [];
        const selected = commands.find((command) => command.kind === goal.commandKind);
        if (!selected || typeof selected.id !== 'string' || typeof selected.risk !== 'string') throw new OperatorError('TASK_TRUSTED_COMMAND_NOT_FOUND', `No trusted ${goal.commandKind} command is configured.`);
        state.commandId = selected.id;
        state.commandRisk = selected.risk;
        state.phase = 'run';
      } else if (step.key === 'run-command') state.phase = 'complete';
      return;
    }
    if (goal.kind === 'docker-lifecycle') {
      if (step.key === 'inspect-docker-project') {
        const output = asRecord(result.output);
        if (output.scope !== 'project') throw new OperatorError('TASK_DOCKER_PROJECT_REQUIRED', 'Docker lifecycle tasks require project-scoped inspection.');
        const fingerprint = String(output.fingerprint ?? '');
        if (!/^[0-9a-f]{64}$/i.test(fingerprint)) throw new OperatorError('TASK_DOCKER_FINGERPRINT_MISSING', 'Docker inspection did not return a valid project fingerprint.');
        verifyDockerServicesPresent(goal.services, output.services);
        state.dockerFingerprint = fingerprint.toLowerCase();
        state.phase = 'manage';
      } else if (step.key === 'manage-docker-services') {
        const output = asRecord(result.output);
        if (output.operation !== goal.operation) throw new OperatorError('TASK_DOCKER_POSTCONDITION_FAILED', 'Docker manage result did not match the requested operation.');
        verifyDockerServicesState(goal.operation, goal.services, output.states);
        state.phase = 'verify';
      } else if (step.key === 'verify-docker-project') {
        const output = asRecord(result.output);
        if (output.scope !== 'project') throw new OperatorError('TASK_DOCKER_PROJECT_REQUIRED', 'Docker verification did not remain project-scoped.');
        verifyDockerServicesState(goal.operation, goal.services, output.services);
        state.phase = 'complete';
      }
      return;
    }
    if (goal.kind === 'postgres-select') {
      if (step.key === 'inspect-postgres-profiles') {
        const profiles = Array.isArray(asRecord(result.output).profiles) ? asRecord(result.output).profiles as Array<Record<string, unknown>> : [];
        const profile = profiles.find((item) => item.id === goal.profileId);
        if (!profile) throw new OperatorError('TASK_POSTGRES_PROFILE_NOT_FOUND', 'Requested PostgreSQL profile is not registered for the authorized root.');
        if (profile.endpoint !== 'loopback' && profile.endpoint !== 'unix_socket') {
          throw new OperatorError('TASK_POSTGRES_PROFILE_NOT_LOCAL', 'PostgreSQL task requires a local trusted profile.');
        }
        state.phase = 'columns';
      } else if (step.key === 'inspect-postgres-columns') {
        const output = asRecord(result.output);
        if (output.profileId !== goal.profileId || output.schema !== (goal.schema ?? 'public') || output.table !== goal.table) {
          throw new OperatorError('TASK_POSTGRES_METADATA_MISMATCH', 'PostgreSQL metadata inspection did not match the requested profile and table.');
        }
        verifyPostgresRequestedColumns(goal, output.rows);
        state.phase = 'select';
      } else if (step.key === 'select-postgres-rows') {
        verifyPostgresSelectResult(goal, result.output);
        state.phase = 'complete';
      }
      return;
    }
    if (goal.kind === 'app-operation') {
      if (step.key === 'inspect-app-target') {
        const element = uniqueInspectedUiaElement(result.output);
        requireUiaOperationSupport(goal.operation, element);
        state.targetIdentity = uiaElementIdentity(element);
        state.phase = 'operate';
      } else if (step.key === 'operate-app-target') {
        verifyUiaOperationResult(goal, result.output);
        state.phase = 'verify';
      } else if (step.key === 'verify-app-target') {
        const element = uniqueInspectedUiaElement(result.output);
        verifyUiaReinspection(goal, element, state.targetIdentity);
        state.phase = 'complete';
      } else if (step.key === 'capture-app-fallback') {
        const capture = verifyAppVisualCaptureResult(goal, result.output);
        state.captureId = capture.captureId;
        state.captureSha256 = capture.sha256;
        state.phase = 'physical-operate';
      } else if (step.key === 'operate-app-physical-fallback') {
        verifyAppPhysicalFallbackResult(goal, result.output);
        delete state.captureId;
        delete state.captureSha256;
        state.phase = 'physical-complete';
      }
      return;
    }
    if (step.key === 'inspect-browser') {
      const tabs = Array.isArray(asRecord(result.output).tabs) ? asRecord(result.output).tabs as Array<Record<string, unknown>> : [];
      const selected = goal.targetId
        ? tabs.find((tab) => tab.id === goal.targetId)
        : tabs.find((tab) => tab.type === 'page');
      if (!selected || typeof selected.id !== 'string') throw new OperatorError('TASK_BROWSER_TARGET_NOT_FOUND', 'No matching semantic browser page target is available.');
      state.targetId = selected.id;
      state.phase = 'navigate';
    } else if (step.key === 'navigate-browser') {
      const output = asRecord(result.output);
      if (typeof output.targetId !== 'string' || output.targetId !== state.targetId || !sameBrowserDestination(String(output.url ?? ''), goal.url)) {
        throw new OperatorError('TASK_BROWSER_POSTCONDITION_FAILED', 'Browser navigation result did not match the selected target and destination.');
      }
      state.phase = 'verify';
    } else if (step.key === 'verify-browser') {
      const target = asRecord(asRecord(result.output).target);
      if (target.id !== state.targetId || !sameBrowserDestination(String(target.url ?? ''), goal.url)) {
        throw new OperatorError('TASK_BROWSER_POSTCONDITION_FAILED', 'Semantic browser re-observation did not confirm the requested destination.');
      }
      state.phase = 'complete';
    }
  }

  fallback({ task }: TaskPlannerContext, step: Extract<PlannerDecision, { type: 'step' }>, result: TaskObservation): boolean {
    if (step.key === 'create-file' && result.error?.code === 'TARGET_EXISTS') {
      task.execution!.plannerState.phase = 'read';
      task.evidence.push(evidence('strategy_fallback', 'info', 'Target already existed; switched to exact-content verification.'));
      return true;
    }
    if (step.key === 'verify-file' && result.error?.code === 'TASK_CONTENT_MISMATCH') {
      const sha256Value = String(asRecord(result.output).sha256 ?? '');
      if (!/^[0-9a-f]{64}$/i.test(sha256Value)) return false;
      task.execution!.plannerState.expectedSha256 = sha256Value.toLowerCase();
      task.execution!.plannerState.phase = 'repair';
      task.evidence.push(evidence('strategy_repair', 'info', 'Existing file content differed; scheduled SHA-preconditioned replacement followed by fresh verification.'));
      return true;
    }
    if (step.key === 'repair-file' && result.error?.code === 'PRECONDITION_FAILED') {
      task.execution!.plannerState.phase = 'read';
      delete task.execution!.plannerState.expectedSha256;
      task.evidence.push(evidence('strategy_fallback', 'info', 'File changed during repair; discarded the stale SHA and switched to fresh read-before-repair observation.'));
      return true;
    }
    if (step.key === 'navigate-browser' && result.error?.code === 'BROWSER_TARGET_NOT_FOUND') {
      task.execution!.plannerState.phase = 'start';
      delete task.execution!.plannerState.targetId;
      task.evidence.push(evidence('strategy_fallback', 'info', 'Browser target disappeared; switched to semantic target re-discovery.'));
      return true;
    }
    if (step.key === 'manage-docker-services' && result.error?.code === 'DOCKER_STATE_CHANGED') {
      task.execution!.plannerState.phase = 'start';
      delete task.execution!.plannerState.dockerFingerprint;
      task.evidence.push(evidence('strategy_fallback', 'info', 'Docker project state changed; switched to fresh inspection before requesting a new approval.'));
      return true;
    }
    const appSemanticFailure = ['UIA_ELEMENT_NOT_FOUND', 'UIA_WAIT_TIMEOUT', 'UIA_UNAVAILABLE', 'WIN32_FALLBACK_NOT_FOUND', 'TASK_UIA_PATTERN_UNAVAILABLE', 'TASK_UIA_TARGET_NOT_UNIQUE'].includes(result.error?.code ?? '');
    if ((step.key === 'inspect-app-target' || step.key === 'operate-app-target') && appSemanticFailure) {
      const goal = task.execution?.plannerState.goal as SemanticTaskGoal | undefined;
      if (goal?.kind === 'app-operation' && goal.physicalFallback) {
        task.execution!.plannerState.phase = 'visual-capture';
        delete task.execution!.plannerState.targetIdentity;
        task.evidence.push(evidence('strategy_fallback', 'info', 'Semantic app targeting was unavailable; switched to the pre-authorized bounded visual fallback contract.', {
          failedStep: step.key,
          errorCode: result.error?.code
        }));
        return true;
      }
      if (step.key === 'operate-app-target') {
        task.execution!.plannerState.phase = 'start';
        delete task.execution!.plannerState.targetIdentity;
        task.evidence.push(evidence('strategy_fallback', 'info', 'UIA target disappeared or timed out; switched to bounded semantic target re-discovery.'));
        return true;
      }
    }
    if (step.key === 'operate-app-physical-fallback' && ['INPUT_CAPTURE_STALE', 'INPUT_CAPTURE_REVALIDATION_FAILED'].includes(result.error?.code ?? '')) {
      task.execution!.plannerState.phase = 'visual-capture';
      delete task.execution!.plannerState.captureId;
      delete task.execution!.plannerState.captureSha256;
      task.evidence.push(evidence('strategy_fallback', 'info', 'Visual state changed before physical dispatch; discarded the stale lease and scheduled a fresh capture with a new action identity.', {
        errorCode: result.error?.code
      }));
      return true;
    }
    return false;
  }
}


export class SemanticWorkflowPlanner implements TaskPlanner {
  readonly id = 'operator.semantic-workflow.v1';
  #atomic = new SemanticTaskPlanner();

  supports(goal: SemanticTaskGoal): boolean { return goal.kind === 'semantic-workflow'; }

  next({ task, goal, budget }: TaskPlannerContext): PlannerDecision {
    if (goal.kind !== 'semantic-workflow') throw new OperatorError('TASK_GOAL_INVALID', 'Workflow planner requires a semantic-workflow goal.');
    const state = task.execution!.plannerState;
    let index = workflowIndex(state, goal.steps.length);
    while (index < goal.steps.length) {
      const child = goal.steps[index]!;
      const childState = workflowChildState(state);
      const proxy = taskWithPlannerState(task, childState);
      const decision = this.#atomic.next({ task: proxy, goal: child, budget });
      state.workflowChildState = proxy.execution!.plannerState;
      if (decision.type === 'complete') {
        task.evidence.push(evidence('workflow_step', 'pass', decision.message, { index, kind: child.kind }));
        index += 1;
        state.workflowIndex = index;
        state.workflowChildState = { phase: 'start' };
        continue;
      }
      return {
        ...decision,
        key: `workflow:${index}:${decision.key}`,
        title: `[${index + 1}/${goal.steps.length}] ${decision.title}`
      };
    }
    return { type: 'complete', message: `Semantic workflow completed ${goal.steps.length} verified goal(s).` };
  }

  accept({ task, goal, budget }: TaskPlannerContext, step: Extract<PlannerDecision, { type: 'step' }>, observation: TaskObservation): void {
    const current = this.#current(task, goal, step, budget);
    this.#atomic.accept({ task: current.proxy, goal: current.child, budget }, current.atomicStep, observation);
    task.execution!.plannerState.workflowChildState = current.proxy.execution!.plannerState;
  }

  fallback({ task, goal, budget }: TaskPlannerContext, step: Extract<PlannerDecision, { type: 'step' }>, observation: TaskObservation): boolean {
    const current = this.#current(task, goal, step, budget);
    const handled = this.#atomic.fallback?.({ task: current.proxy, goal: current.child, budget }, current.atomicStep, observation) ?? false;
    task.execution!.plannerState.workflowChildState = current.proxy.execution!.plannerState;
    return handled;
  }

  #current(task: TaskCapsule, goal: SemanticTaskGoal, step: Extract<PlannerDecision, { type: 'step' }>, budget: TaskPlannerContext['budget']): {
    child: AtomicSemanticTaskGoal;
    proxy: TaskCapsule;
    atomicStep: Extract<PlannerDecision, { type: 'step' }>;
  } {
    if (goal.kind !== 'semantic-workflow') throw new OperatorError('TASK_GOAL_INVALID', 'Workflow planner requires a semantic-workflow goal.');
    const state = task.execution!.plannerState;
    const index = workflowIndex(state, goal.steps.length);
    const child = goal.steps[index];
    if (!child) throw new OperatorError('TASK_WORKFLOW_STATE_INVALID', 'Workflow action has no current semantic child goal.');
    const proxy = taskWithPlannerState(task, workflowChildState(state));
    const expected = this.#atomic.next({ task: proxy, goal: child, budget });
    if (expected.type !== 'step' || step.key !== `workflow:${index}:${expected.key}`) {
      throw new OperatorError('TASK_WORKFLOW_STATE_INVALID', 'Workflow action does not match the current semantic child state.');
    }
    return { child, proxy, atomicStep: expected };
  }
}

function semanticLearningContext(goal: SemanticTaskGoal, task: TaskCapsule): string {
  if (goal.kind !== 'semantic-workflow') return goal.kind;
  const state = task.execution?.plannerState;
  if (!state) return 'semantic-workflow';
  const index = state.workflowIndex === undefined ? 0 : Number(state.workflowIndex);
  if (!Number.isSafeInteger(index) || index < 0 || index >= goal.steps.length) return 'semantic-workflow';
  return goal.steps[index]?.kind ?? 'semantic-workflow';
}

function workflowIndex(state: Record<string, unknown>, length: number): number {
  const value = state.workflowIndex === undefined ? 0 : Number(state.workflowIndex);
  if (!Number.isSafeInteger(value) || value < 0 || value > length) {
    throw new OperatorError('TASK_WORKFLOW_STATE_INVALID', 'Workflow child index is invalid.');
  }
  return value;
}

function workflowChildState(state: Record<string, unknown>): Record<string, unknown> {
  const value = state.workflowChildState;
  if (value === undefined) return { phase: 'start' };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new OperatorError('TASK_WORKFLOW_STATE_INVALID', 'Workflow child planner state is invalid.');
  }
  return structuredClone(value as Record<string, unknown>);
}

function taskWithPlannerState(task: TaskCapsule, plannerState: Record<string, unknown>): TaskCapsule {
  if (!task.execution) throw new OperatorError('TASK_EXECUTION_MISSING', 'Task has no execution metadata.');
  return {
    ...task,
    execution: { ...task.execution, plannerState },
    evidence: task.evidence,
    nodes: task.nodes,
    failures: task.failures
  };
}

function parseGoal(input: unknown, expectedKind: string): SemanticTaskGoal {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new OperatorError('TASK_GOAL_INVALID', 'Stored task goal is invalid.');
  const goal = structuredClone(input) as SemanticTaskGoal;
  if (goal.kind !== expectedKind) throw new OperatorError('TASK_GOAL_INVALID', 'Stored task goal kind does not match execution metadata.');
  if (goal.kind === 'semantic-workflow') {
    if (!Array.isArray(goal.steps) || goal.steps.length < 1 || goal.steps.length > 20) {
      throw new OperatorError('TASK_GOAL_INVALID', 'Semantic workflow requires 1-20 typed child goals.');
    }
    goal.steps = goal.steps.map((step, index) => {
      if (!step || typeof step !== 'object' || Array.isArray(step)) throw new OperatorError('TASK_GOAL_INVALID', `Workflow step ${index} is invalid.`);
      const kind = String((step as { kind?: unknown }).kind ?? '');
      if (kind === 'semantic-workflow') throw new OperatorError('TASK_GOAL_INVALID', 'Nested semantic workflows are not permitted.');
      return parseGoal(step, kind) as AtomicSemanticTaskGoal;
    });
  } else if (goal.kind === 'controlled-file-change') {
    boundedText(goal.root, 4096, 'goal root'); boundedText(goal.path, 4096, 'goal path'); boundedText(goal.content, 2 * 1024 * 1024, 'goal content');
    const root = path.resolve(goal.root);
    const target = path.resolve(root, goal.path);
    const relative = path.relative(root, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new OperatorError('TASK_GOAL_INVALID', 'Controlled file path must remain inside its goal root.');
    goal.root = root;
    goal.path = target;
  } else if (goal.kind === 'trusted-project-command') {
    boundedText(goal.root, 4096, 'goal root');
    if (!['build', 'test', 'lint'].includes(goal.commandKind)) throw new OperatorError('TASK_GOAL_INVALID', 'Trusted command kind is invalid.');
    goal.root = path.resolve(goal.root);
  } else if (goal.kind === 'project-quality-gate') {
    goal.root = path.resolve(boundedText(goal.root, 4096, 'quality gate root'));
    const requested = goal.checks === undefined ? ['lint', 'test', 'build'] : goal.checks;
    if (!Array.isArray(requested) || requested.length < 1 || requested.length > 3) {
      throw new OperatorError('TASK_GOAL_INVALID', 'Project quality gate requires 1-3 lint/test/build checks.');
    }
    const checks = requested.map((check) => String(check) as ProjectQualityCheck);
    if (checks.some((check) => !['lint', 'test', 'build'].includes(check)) || new Set(checks).size !== checks.length) {
      throw new OperatorError('TASK_GOAL_INVALID', 'Project quality gate checks must be unique lint/test/build values.');
    }
    if (goal.requireAll !== undefined && typeof goal.requireAll !== 'boolean') {
      throw new OperatorError('TASK_GOAL_INVALID', 'Project quality gate requireAll must be boolean.');
    }
    goal.checks = checks;
    goal.requireAll = goal.requireAll ?? false;
  } else if (goal.kind === 'browser-navigation') {
    const rawUrl = boundedText(goal.url, 16_384, 'goal URL');
    let url: URL;
    try { url = new URL(rawUrl); } catch { throw new OperatorError('TASK_GOAL_INVALID', 'Browser goal requires a valid absolute URL.'); }
    if (!['http:', 'https:'].includes(url.protocol)) throw new OperatorError('TASK_GOAL_INVALID', 'Browser goal permits only HTTP(S) destinations.');
    if (url.username || url.password) throw new OperatorError('TASK_GOAL_INVALID', 'Browser goal URL must not contain credentials.');
    goal.url = url.toString();
    if (goal.targetId !== undefined) goal.targetId = boundedText(goal.targetId, 256, 'browser targetId');
  } else if (goal.kind === 'docker-lifecycle') {
    goal.root = path.resolve(boundedText(goal.root, 4096, 'docker root'));
    if (!['start', 'stop', 'restart'].includes(goal.operation)) throw new OperatorError('TASK_GOAL_INVALID', 'Docker lifecycle operation must be start, stop, or restart.');
    if (!Array.isArray(goal.services) || goal.services.length < 1 || goal.services.length > 50) throw new OperatorError('TASK_GOAL_INVALID', 'Docker lifecycle requires 1-50 service names.');
    goal.services = [...new Set(goal.services.map((service, index) => {
      const value = boundedText(service, 128, `docker services[${index}]`);
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)) throw new OperatorError('TASK_GOAL_INVALID', 'Docker service names must use bounded alphanumeric/._- characters.');
      return value;
    }))].sort();
    goal.timeoutMs = boundedInteger(goal.timeoutMs, 1_000, 300_000, 60_000);
  } else if (goal.kind === 'postgres-select') {
    goal.root = path.resolve(boundedText(goal.root, 4096, 'postgres root'));
    goal.profileId = boundedText(goal.profileId, 64, 'postgres profileId');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(goal.profileId)) throw new OperatorError('TASK_GOAL_INVALID', 'PostgreSQL profileId is invalid.');
    goal.schema = postgresIdentifier(goal.schema ?? 'public', 'postgres schema');
    goal.table = postgresIdentifier(goal.table, 'postgres table');
    goal.columns = normalizePostgresColumns(goal.columns ?? []);
    goal.filters = normalizePostgresFilters(goal.filters ?? []);
    goal.orderBy = normalizePostgresOrder(goal.orderBy ?? []);
    goal.limit = boundedInteger(goal.limit, 1, 500, 100);
    goal.offset = boundedInteger(goal.offset, 0, 10_000, 0);
    goal.timeoutMs = boundedInteger(goal.timeoutMs, 100, 30_000, 5_000);
  } else if (goal.kind === 'app-operation') {
    goal.selector = normalizeUiaTaskSelector(goal.selector, 'app selector');
    if (goal.verifySelector !== undefined) goal.verifySelector = normalizeUiaTaskSelector(goal.verifySelector, 'app verifySelector');
    if (!UIA_TASK_OPERATIONS.includes(goal.operation)) throw new OperatorError('TASK_GOAL_INVALID', 'App operation is not in the closed semantic operation set.');
    if (goal.operation === 'invoke' && goal.verifySelector === undefined) throw new OperatorError('TASK_GOAL_INVALID', 'Invoke tasks require a semantic verifySelector so their external effect can be re-observed.');
    if (goal.operation === 'set_value') goal.value = boundedText(goal.value, 64 * 1024, 'app value');
    else if (goal.value !== undefined) throw new OperatorError('TASK_GOAL_INVALID', `${goal.operation} does not accept a value.`);
    if (goal.operation === 'scroll') {
      if (goal.horizontalAmount === undefined && goal.verticalAmount === undefined) throw new OperatorError('TASK_GOAL_INVALID', 'Scroll requires a bounded horizontalAmount or verticalAmount.');
      if (goal.horizontalAmount !== undefined) goal.horizontalAmount = validUiaScrollAmount(goal.horizontalAmount, 'horizontalAmount');
      if (goal.verticalAmount !== undefined) goal.verticalAmount = validUiaScrollAmount(goal.verticalAmount, 'verticalAmount');
    } else if (goal.horizontalAmount !== undefined || goal.verticalAmount !== undefined) {
      throw new OperatorError('TASK_GOAL_INVALID', `${goal.operation} does not accept scroll amounts.`);
    }
    goal.waitMs = boundedInteger(goal.waitMs, 0, 10_000, 0);
    if (goal.physicalFallback !== undefined) goal.physicalFallback = normalizeAppPhysicalFallback(goal.physicalFallback, 'app physicalFallback');
  } else throw new OperatorError('TASK_GOAL_INVALID', 'Task goal kind is unsupported.');
  return goal;
}

function postgresIdentifier(input: unknown, label: string): string {
  const value = boundedText(input, 63, label);
  if (!/^[A-Za-z_][A-Za-z0-9_$]{0,62}$/.test(value)) throw new OperatorError('TASK_GOAL_INVALID', `${label} is not a valid bounded PostgreSQL identifier.`);
  return value;
}

function normalizePostgresColumns(input: unknown): string[] {
  if (!Array.isArray(input) || input.length > 50) throw new OperatorError('TASK_GOAL_INVALID', 'PostgreSQL columns must contain at most 50 identifiers.');
  const columns = input.map((value, index) => postgresIdentifier(value, `postgres columns[${index}]`));
  if (new Set(columns).size !== columns.length) throw new OperatorError('TASK_GOAL_INVALID', 'PostgreSQL columns must not contain duplicates.');
  return columns;
}

function normalizePostgresFilters(input: unknown): PostgresTaskFilter[] {
  if (!Array.isArray(input) || input.length > 20) throw new OperatorError('TASK_GOAL_INVALID', 'PostgreSQL filters must contain at most 20 entries.');
  const ops = new Set<PostgresTaskFilter['op']>(['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'like', 'ilike', 'is_null', 'not_null']);
  return input.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new OperatorError('TASK_GOAL_INVALID', `postgres filters[${index}] must be an object.`);
    const raw = entry as Record<string, unknown>;
    const column = postgresIdentifier(raw.column, `postgres filters[${index}].column`);
    const op = String(raw.op ?? '') as PostgresTaskFilter['op'];
    if (!ops.has(op)) throw new OperatorError('TASK_GOAL_INVALID', `postgres filters[${index}].op is invalid.`);
    if (op === 'is_null' || op === 'not_null') return { column, op };
    const value = raw.value === undefined ? '' : raw.value;
    if (typeof value !== 'string' || value.length > 100_000 || value.includes('\0')) throw new OperatorError('TASK_GOAL_INVALID', `postgres filters[${index}].value is invalid.`);
    return { column, op, value };
  });
}

function normalizePostgresOrder(input: unknown): PostgresTaskOrder[] {
  if (!Array.isArray(input) || input.length > 5) throw new OperatorError('TASK_GOAL_INVALID', 'PostgreSQL orderBy must contain at most 5 entries.');
  return input.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new OperatorError('TASK_GOAL_INVALID', `postgres orderBy[${index}] must be an object.`);
    const raw = entry as Record<string, unknown>;
    const column = postgresIdentifier(raw.column, `postgres orderBy[${index}].column`);
    const direction = String(raw.direction ?? '');
    if (direction !== 'asc' && direction !== 'desc') throw new OperatorError('TASK_GOAL_INVALID', `postgres orderBy[${index}].direction is invalid.`);
    return { column, direction };
  });
}

function verifyPostgresRequestedColumns(goal: Extract<SemanticTaskGoal, { kind: 'postgres-select' }>, input: unknown): void {
  const rows = Array.isArray(input) ? input.map(asRecord) : [];
  const available = new Set(rows.map((row) => String(row.column_name ?? '')).filter(Boolean));
  const required = new Set([
    ...(goal.columns ?? []),
    ...(goal.filters ?? []).map((filter) => filter.column),
    ...(goal.orderBy ?? []).map((order) => order.column)
  ]);
  for (const column of required) {
    if (!available.has(column)) throw new OperatorError('TASK_POSTGRES_COLUMN_MISSING', `PostgreSQL column ${column} is not present in the current table metadata.`);
  }
}

function verifyPostgresSelectResult(goal: Extract<SemanticTaskGoal, { kind: 'postgres-select' }>, input: unknown): void {
  const output = asRecord(input);
  if (output.profileId !== goal.profileId || output.schema !== (goal.schema ?? 'public') || output.table !== goal.table) {
    throw new OperatorError('TASK_POSTGRES_SELECT_MISMATCH', 'PostgreSQL SELECT result did not match the requested profile and table.');
  }
  const rowCount = Number(output.rowCount);
  const limit = goal.limit ?? 100;
  if (!Number.isSafeInteger(rowCount) || rowCount < 0 || rowCount > limit) throw new OperatorError('TASK_POSTGRES_SELECT_MISMATCH', 'PostgreSQL SELECT returned an invalid row count.');
  const rows = Array.isArray(output.rows) ? output.rows : [];
  if (rows.length !== rowCount) throw new OperatorError('TASK_POSTGRES_SELECT_MISMATCH', 'PostgreSQL SELECT row count did not match returned rows.');
  if (Number(output.limit) !== limit || Number(output.offset) !== (goal.offset ?? 0)) throw new OperatorError('TASK_POSTGRES_SELECT_MISMATCH', 'PostgreSQL SELECT pagination did not match the requested bounds.');
  const expectedColumns = (goal.columns ?? []).length === 0 ? ['*'] : goal.columns!;
  const actualColumns = Array.isArray(output.columns) ? output.columns.map(String) : [];
  if (canonicalJson(actualColumns) !== canonicalJson(expectedColumns)) throw new OperatorError('TASK_POSTGRES_SELECT_MISMATCH', 'PostgreSQL SELECT columns did not match the requested projection.');
}

function verifyDockerServicesPresent(expectedServices: string[], input: unknown): void {
  const services = Array.isArray(input) ? input.map(asRecord) : [];
  for (const service of expectedServices) {
    const found = services.find((item) => item.service === service);
    if (!found) throw new OperatorError('TASK_DOCKER_SERVICE_MISSING', `Docker inspection did not report service ${service}.`);
    const containers = Number(found.containers ?? 0);
    if (!Number.isSafeInteger(containers) || containers < 1) throw new OperatorError('TASK_DOCKER_SERVICE_MISSING', `Docker service ${service} has no created containers.`);
  }
}

function verifyDockerServicesState(operation: 'start' | 'stop' | 'restart', expectedServices: string[], input: unknown): void {
  const services = Array.isArray(input) ? input.map(asRecord) : [];
  for (const service of expectedServices) {
    const found = services.find((item) => item.service === service);
    if (!found) throw new OperatorError('TASK_DOCKER_POSTCONDITION_FAILED', `Docker service ${service} disappeared during verification.`);
    const states = Array.isArray(found.states) ? found.states.map(String) : [];
    if (states.length === 0) throw new OperatorError('TASK_DOCKER_POSTCONDITION_FAILED', `Docker service ${service} returned no container states.`);
    const expectedState = operation === 'stop' ? 'exited' : 'running';
    if (!states.every((state) => state === expectedState)) {
      throw new OperatorError('TASK_DOCKER_POSTCONDITION_FAILED', `Docker service ${service} did not reach ${expectedState}.`);
    }
  }
}

const UIA_TASK_OPERATIONS: readonly UiaTaskOperation[] = ['invoke', 'set_value', 'focus', 'select', 'expand', 'collapse', 'scroll', 'activate_window'];
const UIA_SCROLL_AMOUNTS = ['large_decrement', 'small_decrement', 'none', 'large_increment', 'small_increment'] as const;
const PHYSICAL_INPUT_TASK_OPERATIONS: readonly PhysicalInputTaskOperation[] = ['move', 'click', 'double_click', 'drag', 'scroll', 'type_text', 'key_press', 'hotkey'];

function requireAppPhysicalFallback(goal: Extract<SemanticTaskGoal, { kind: 'app-operation' }>): AppPhysicalFallback {
  if (!goal.physicalFallback) throw new OperatorError('TASK_VISUAL_FALLBACK_NOT_AUTHORIZED', 'Application goal does not authorize physical fallback.');
  return goal.physicalFallback;
}

function normalizeAppPhysicalFallback(input: unknown, label: string): AppPhysicalFallback {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new OperatorError('TASK_GOAL_INVALID', `${label} must be an object.`);
  const raw = input as Record<string, unknown>;
  const allowed = new Set(['source', 'selector', 'region', 'operation', 'x', 'y', 'toX', 'toY', 'deltaX', 'deltaY', 'text', 'key', 'keys', 'maxWidth', 'maxHeight']);
  if (Object.keys(raw).some((key) => !allowed.has(key))) throw new OperatorError('TASK_GOAL_INVALID', `${label} contains an unsupported field.`);

  const source = String(raw.source ?? '') as AppPhysicalFallback['source'];
  if (!['screen', 'window', 'region'].includes(source)) throw new OperatorError('TASK_GOAL_INVALID', `${label}.source must be screen, window, or region.`);
  const operation = String(raw.operation ?? '') as PhysicalInputTaskOperation;
  if (!PHYSICAL_INPUT_TASK_OPERATIONS.includes(operation)) throw new OperatorError('TASK_GOAL_INVALID', `${label}.operation is outside the closed physical input set.`);
  const maxWidth = optionalTaskInteger(raw.maxWidth, 1, 1280, `${label}.maxWidth`) ?? 960;
  const maxHeight = optionalTaskInteger(raw.maxHeight, 1, 720, `${label}.maxHeight`) ?? 540;

  let selector: VisualTaskSelector | undefined;
  let region: AppPhysicalFallback['region'];
  if (source === 'window') {
    selector = normalizeVisualTaskSelector(raw.selector, `${label}.selector`);
    if (raw.region !== undefined) throw new OperatorError('TASK_GOAL_INVALID', `${label}.region is not accepted for window capture.`);
  } else if (source === 'region') {
    if (raw.selector !== undefined) throw new OperatorError('TASK_GOAL_INVALID', `${label}.selector is not accepted for region capture.`);
    if (!raw.region || typeof raw.region !== 'object' || Array.isArray(raw.region)) throw new OperatorError('TASK_GOAL_INVALID', `${label}.region is required for region capture.`);
    const value = raw.region as Record<string, unknown>;
    const regionAllowed = new Set(['x', 'y', 'width', 'height']);
    if (Object.keys(value).some((key) => !regionAllowed.has(key))) throw new OperatorError('TASK_GOAL_INVALID', `${label}.region contains an unsupported field.`);
    region = {
      x: requiredTaskInteger(value.x, -100_000, 100_000, `${label}.region.x`),
      y: requiredTaskInteger(value.y, -100_000, 100_000, `${label}.region.y`),
      width: requiredTaskInteger(value.width, 1, 16_384, `${label}.region.width`),
      height: requiredTaskInteger(value.height, 1, 16_384, `${label}.region.height`)
    };
  } else if (raw.selector !== undefined || raw.region !== undefined) {
    throw new OperatorError('TASK_GOAL_INVALID', `${label} screen capture does not accept selector or region.`);
  }

  const fallback: AppPhysicalFallback = { source, operation, maxWidth, maxHeight, ...(selector ? { selector } : {}), ...(region ? { region } : {}) };
  const x = optionalTaskInteger(raw.x, 0, maxWidth - 1, `${label}.x`);
  const y = optionalTaskInteger(raw.y, 0, maxHeight - 1, `${label}.y`);
  const toX = optionalTaskInteger(raw.toX, 0, maxWidth - 1, `${label}.toX`);
  const toY = optionalTaskInteger(raw.toY, 0, maxHeight - 1, `${label}.toY`);
  const deltaX = optionalTaskInteger(raw.deltaX, -1200, 1200, `${label}.deltaX`);
  const deltaY = optionalTaskInteger(raw.deltaY, -1200, 1200, `${label}.deltaY`);

  if (['move', 'click', 'double_click', 'drag', 'scroll'].includes(operation)) {
    if (x === undefined || y === undefined) throw new OperatorError('TASK_GOAL_INVALID', `${label} pointer operation requires x and y in capture coordinates.`);
    fallback.x = x; fallback.y = y;
  } else if ([x, y, toX, toY, deltaX, deltaY].some((value) => value !== undefined)) {
    throw new OperatorError('TASK_GOAL_INVALID', `${label} keyboard operation does not accept pointer fields.`);
  }
  if (operation === 'drag') {
    if (toX === undefined || toY === undefined) throw new OperatorError('TASK_GOAL_INVALID', `${label}.drag requires toX and toY.`);
    fallback.toX = toX; fallback.toY = toY;
  } else if (toX !== undefined || toY !== undefined) throw new OperatorError('TASK_GOAL_INVALID', `${label}.toX/toY are accepted only for drag.`);

  if (operation === 'scroll') {
    if ((deltaX ?? 0) === 0 && (deltaY ?? 0) === 0) throw new OperatorError('TASK_GOAL_INVALID', `${label}.scroll requires a non-zero deltaX or deltaY.`);
    fallback.deltaX = deltaX ?? 0; fallback.deltaY = deltaY ?? 0;
  } else if (deltaX !== undefined || deltaY !== undefined) throw new OperatorError('TASK_GOAL_INVALID', `${label}.deltaX/deltaY are accepted only for scroll.`);

  if (operation === 'type_text') fallback.text = boundedText(raw.text, 4096, `${label}.text`);
  else if (raw.text !== undefined) throw new OperatorError('TASK_GOAL_INVALID', `${label}.text is accepted only for type_text.`);
  if (operation === 'key_press') fallback.key = boundedText(raw.key, 32, `${label}.key`);
  else if (raw.key !== undefined) throw new OperatorError('TASK_GOAL_INVALID', `${label}.key is accepted only for key_press.`);
  if (operation === 'hotkey') {
    const keys = boundedTextArray(raw.keys, 4, 32, `${label}.keys`);
    if (keys.length < 1) throw new OperatorError('TASK_GOAL_INVALID', `${label}.keys requires 1-4 keys.`);
    fallback.keys = keys;
  } else if (raw.keys !== undefined) throw new OperatorError('TASK_GOAL_INVALID', `${label}.keys is accepted only for hotkey.`);

  if (['type_text', 'key_press', 'hotkey'].includes(operation) && source !== 'window') {
    throw new OperatorError('TASK_GOAL_INVALID', `${label} keyboard fallback requires a window capture so foreground identity can be verified.`);
  }
  return fallback;
}

function normalizeVisualTaskSelector(input: unknown, label: string): VisualTaskSelector {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new OperatorError('TASK_GOAL_INVALID', `${label} must be an object.`);
  const raw = input as Record<string, unknown>;
  const allowed = new Set(['name', 'className', 'processId']);
  if (Object.keys(raw).some((key) => !allowed.has(key))) throw new OperatorError('TASK_GOAL_INVALID', `${label} supports only name, className, and processId.`);
  const selector: VisualTaskSelector = {};
  if (raw.name !== undefined) selector.name = boundedText(raw.name, 512, `${label}.name`);
  if (raw.className !== undefined) selector.className = boundedText(raw.className, 512, `${label}.className`);
  if (raw.processId !== undefined) selector.processId = requiredTaskInteger(raw.processId, 1, 0xffff_ffff, `${label}.processId`);
  if (Object.keys(selector).length === 0) throw new OperatorError('TASK_GOAL_INVALID', `${label} must identify one top-level window.`);
  return selector;
}

function requiredTaskInteger(value: unknown, min: number, max: number, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new OperatorError('TASK_GOAL_INVALID', `${label} must be an integer from ${min} to ${max}.`);
  return parsed;
}

function optionalTaskInteger(value: unknown, min: number, max: number, label: string): number | undefined {
  return value === undefined ? undefined : requiredTaskInteger(value, min, max, label);
}

function verifyAppVisualCaptureResult(
  goal: Extract<SemanticTaskGoal, { kind: 'app-operation' }>,
  outputValue: unknown
): { captureId: string; sha256: string } {
  const fallback = requireAppPhysicalFallback(goal);
  const output = asRecord(outputValue);
  const captureId = boundedText(output.captureId, 128, 'visual captureId');
  const sha256Value = boundedText(output.sha256, 64, 'visual capture SHA-256').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha256Value)) throw new OperatorError('TASK_VISUAL_CAPTURE_INVALID', 'Visual fallback capture did not return a valid SHA-256.');
  const width = requiredTaskInteger(output.width, 1, 1280, 'visual capture width');
  const height = requiredTaskInteger(output.height, 1, 720, 'visual capture height');
  for (const [x, y, label] of [[fallback.x, fallback.y, 'target'], [fallback.toX, fallback.toY, 'drag target']] as const) {
    if (x === undefined && y === undefined) continue;
    if (x === undefined || y === undefined || x >= width || y >= height) throw new OperatorError('TASK_VISUAL_POINT_OUTSIDE_CAPTURE', `Physical fallback ${label} is outside the returned capture.`);
  }
  if (['type_text', 'key_press', 'hotkey'].includes(fallback.operation) && typeof output.windowId !== 'string') {
    throw new OperatorError('TASK_VISUAL_WINDOW_IDENTITY_MISSING', 'Keyboard visual fallback requires a capture-bound window identity.');
  }
  return { captureId, sha256: sha256Value };
}

function verifyAppPhysicalFallbackResult(
  goal: Extract<SemanticTaskGoal, { kind: 'app-operation' }>,
  outputValue: unknown
): void {
  const fallback = requireAppPhysicalFallback(goal);
  const output = asRecord(outputValue);
  if (output.operation !== fallback.operation) throw new OperatorError('TASK_PHYSICAL_POSTCONDITION_FAILED', 'Physical fallback result did not identify the requested operation.');
  const postcondition = asRecord(output.postcondition);
  if (postcondition.dispatched !== true || postcondition.captureLeaseConsumed !== true || postcondition.afterCaptured !== true) {
    throw new OperatorError('TASK_PHYSICAL_POSTCONDITION_FAILED', 'Physical fallback did not prove dispatch, one-shot lease consumption, and AFTER capture.');
  }
  const afterSha256 = String(postcondition.afterSha256 ?? '');
  if (!/^[0-9a-f]{64}$/i.test(afterSha256)) throw new OperatorError('TASK_PHYSICAL_POSTCONDITION_FAILED', 'Physical fallback AFTER capture did not return a valid SHA-256.');
  if (fallback.source === 'window' && postcondition.windowStable !== true) {
    throw new OperatorError('TASK_PHYSICAL_POSTCONDITION_FAILED', 'Physical fallback AFTER capture did not preserve the capture-bound window identity.');
  }
}

function normalizeUiaTaskSelector(input: unknown, label: string): UiaTaskSelector {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new OperatorError('TASK_GOAL_INVALID', `${label} must be an object.`);
  const raw = input as Record<string, unknown>;
  const allowed = new Set(['name', 'automationId', 'className', 'controlType', 'processId']);
  if (Object.keys(raw).some((key) => !allowed.has(key))) throw new OperatorError('TASK_GOAL_INVALID', `${label} contains an unsupported selector field.`);
  const selector: UiaTaskSelector = {};
  for (const key of ['name', 'automationId', 'className', 'controlType'] as const) {
    if (raw[key] !== undefined) selector[key] = boundedText(raw[key], 512, `${label}.${key}`);
  }
  if (raw.processId !== undefined) {
    const pid = Number(raw.processId);
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffff_ffff) throw new OperatorError('TASK_GOAL_INVALID', `${label}.processId is invalid.`);
    selector.processId = pid;
  }
  if (Object.keys(selector).length === 0) throw new OperatorError('TASK_GOAL_INVALID', `${label} must identify a semantic UIA target.`);
  return selector;
}

function validUiaScrollAmount(input: unknown, label: string): string {
  if (typeof input !== 'string' || !(UIA_SCROLL_AMOUNTS as readonly string[]).includes(input)) {
    throw new OperatorError('TASK_GOAL_INVALID', `${label} must be one of ${UIA_SCROLL_AMOUNTS.join(', ')}.`);
  }
  return input;
}

function uniqueInspectedUiaElement(output: unknown): Record<string, unknown> {
  const elements = Array.isArray(asRecord(output).elements) ? asRecord(output).elements as unknown[] : [];
  if (elements.length !== 1 || !elements[0] || typeof elements[0] !== 'object' || Array.isArray(elements[0])) {
    throw new OperatorError('TASK_UIA_TARGET_NOT_UNIQUE', 'UIA inspection did not return exactly one semantic target.');
  }
  return elements[0] as Record<string, unknown>;
}

function requireUiaOperationSupport(operation: UiaTaskOperation, element: Record<string, unknown>): void {
  const patterns = asRecord(element.patterns);
  const supported = operation === 'invoke' ? patterns.invoke === true || patterns.legacy_iaccessible === true
    : operation === 'set_value' ? patterns.value === true || patterns.legacy_iaccessible === true
    : operation === 'select' ? patterns.selection_item === true
    : operation === 'expand' || operation === 'collapse' ? patterns.expand_collapse === true
    : operation === 'scroll' ? patterns.scroll === true
    : true;
  if (!supported) throw new OperatorError('TASK_UIA_PATTERN_UNAVAILABLE', `Semantic target does not support ${operation}.`);
}

function uiaElementIdentity(element: Record<string, unknown>): Record<string, unknown> {
  return {
    automationId: String(element.automation_id ?? ''), className: String(element.class_name ?? ''),
    controlType: String(element.control_type ?? ''), processId: Number(element.process_id ?? 0)
  };
}

function verifyUiaOperationResult(goal: Extract<SemanticTaskGoal, { kind: 'app-operation' }>, outputValue: unknown): void {
  const output = asRecord(outputValue);
  if (output.operation !== goal.operation) throw new OperatorError('TASK_UIA_POSTCONDITION_FAILED', 'UIA operation result did not identify the requested operation.');
  const postcondition = asRecord(output.postcondition);
  if (goal.operation === 'invoke') {
    if (postcondition.element_reachable !== true) throw new OperatorError('TASK_UIA_POSTCONDITION_FAILED', 'UIA invoke did not prove the semantic target was reached.');
    return;
  }
  if (postcondition.verified !== true) throw new OperatorError('TASK_UIA_POSTCONDITION_FAILED', 'UIA operation did not return a verified semantic postcondition.');
  if (goal.operation === 'set_value' && postcondition.actual_value !== goal.value) {
    throw new OperatorError('TASK_UIA_POSTCONDITION_FAILED', 'UIA set_value did not verify the requested exact value.');
  }
}

function verifyUiaReinspection(
  goal: Extract<SemanticTaskGoal, { kind: 'app-operation' }>,
  element: Record<string, unknown>,
  priorIdentity: unknown
): void {
  if (goal.verifySelector === undefined) {
    const before = asRecord(priorIdentity);
    const after = uiaElementIdentity(element);
    for (const key of ['automationId', 'className', 'controlType', 'processId']) {
      if (before[key] !== undefined && before[key] !== '' && before[key] !== 0 && before[key] !== after[key]) {
        throw new OperatorError('TASK_UIA_POSTCONDITION_FAILED', 'UIA re-inspection resolved to a different semantic target.');
      }
    }
  }
  if (goal.operation === 'set_value' && element.value !== goal.value) throw new OperatorError('TASK_UIA_POSTCONDITION_FAILED', 'UIA re-inspection did not confirm the requested value.');
  if (goal.operation === 'select' && element.selected !== true) throw new OperatorError('TASK_UIA_POSTCONDITION_FAILED', 'UIA re-inspection did not confirm selection.');
  if (goal.operation === 'expand' && element.expand_collapse_state !== 'Expanded') throw new OperatorError('TASK_UIA_POSTCONDITION_FAILED', 'UIA re-inspection did not confirm expansion.');
  if (goal.operation === 'collapse' && element.expand_collapse_state !== 'Collapsed') throw new OperatorError('TASK_UIA_POSTCONDITION_FAILED', 'UIA re-inspection did not confirm collapse.');
}

function validTaskRequestId(input: unknown): string {
  const value = String(input ?? '').toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw new OperatorError('TASK_SUBMISSION_ID_INVALID', 'Task submission requestId must be a UUID.');
  }
  return value;
}

function sameTaskSubmission(
  task: TaskCapsule,
  plannerId: string,
  goal: SemanticTaskGoal,
  normalized: {
    userObjective: string;
    authorizedScope: string[];
    prohibitedScope: string[];
    successConditions: string[];
    maxSteps: number;
    maxAttemptsPerStep: number;
    timeoutMs: number;
    intent?: IntentBinding;
  }
): boolean {
  const execution = task.execution;
  if (!execution) return false;
  return task.userObjective === normalized.userObjective
    && task.interpretedObjective === `${goal.kind}:${normalized.userObjective}`
    && canonicalJson(task.authorizedScope) === canonicalJson(normalized.authorizedScope)
    && canonicalJson(task.prohibitedScope) === canonicalJson(normalized.prohibitedScope)
    && canonicalJson(task.successConditions) === canonicalJson(normalized.successConditions)
    && canonicalJson(task.intent ?? null) === canonicalJson(normalized.intent ?? null)
    && execution.plannerId === plannerId
    && execution.goalKind === goal.kind
    && canonicalJson(execution.plannerState.goal) === canonicalJson(goal)
    && execution.maxSteps === normalized.maxSteps
    && execution.maxAttemptsPerStep === normalized.maxAttemptsPerStep
    && execution.timeoutMs === normalized.timeoutMs;
}

function deterministicActionId(taskId: string, stepKey: string, attempt: number, inputHash: string): string {
  return `task-${sha256(`${taskId}\0${stepKey}\0${attempt}\0${inputHash}`)}`;
}
function validatePlannerDecision(value: unknown): PlannerDecision {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OperatorError('TASK_PLANNER_OUTPUT_INVALID', 'Planner decision must be a structured object.');
  const record = value as Record<string, unknown>;
  if (record.type === 'complete') {
    return { type: 'complete', message: boundedText(record.message, 4096, 'planner completion message') };
  }
  if (record.type !== 'step') throw new OperatorError('TASK_PLANNER_OUTPUT_INVALID', 'Planner decision type must be complete or step.');
  const input = record.input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new OperatorError('TASK_PLANNER_OUTPUT_INVALID', 'Planner step input must be a structured object.');
  return {
    type: 'step',
    key: boundedText(record.key, 256, 'planner step key'),
    title: boundedText(record.title, 512, 'planner step title'),
    capability: boundedText(record.capability, 256, 'planner capability'),
    input: structuredClone(input as Record<string, unknown>),
    ...(record.target === undefined ? {} : { target: boundedText(record.target, 4096, 'planner target') })
  };
}

function sha256(value: string): string { return crypto.createHash('sha256').update(value).digest('hex'); }
function observe(result: ActionResult): TaskObservation {
  const channel: TaskObservation['channel'] = result.capability === 'visual.capture' || result.capability === 'input.operate' ? 'visual' : 'semantic';
  return {
    channel, domain: observationDomain(result.capability, result.provider), observedAt: new Date().toISOString(),
    ok: result.ok, capability: result.capability, provider: result.provider,
    ...(result.output === undefined ? {} : { output: structuredClone(result.output) }),
    evidence: structuredClone(result.evidence),
    ...(result.error === undefined ? {} : { error: structuredClone(result.error) })
  };
}
function detectPlannerLoop(records: TaskActionRecord[], stepKey: string, inputHash: string): boolean {
  const signatures = records
    .filter((record) => record.state !== 'BLOCKED' && record.state !== 'STARTED')
    .map((record) => `${record.stepKey}:${record.inputHash}`);
  signatures.push(`${stepKey}:${inputHash}`);
  for (const width of [1, 2, 3]) {
    if (signatures.length < 3 * width) continue;
    const tail = signatures.slice(-width);
    const prior = signatures.slice(-2 * width, -width);
    const earlier = signatures.slice(-3 * width, -2 * width);
    if (tail.join('\0') === prior.join('\0') && tail.join('\0') === earlier.join('\0')) return true;
  }
  return false;
}
function sameBrowserDestination(actualRaw: string, expectedRaw: string): boolean {
  try {
    const actual = new URL(actualRaw);
    const expected = new URL(expectedRaw);
    actual.hash = '';
    expected.hash = '';
    return actual.origin === expected.origin
      && actual.search === expected.search
      && (actual.pathname === expected.pathname || actual.pathname.replace(/\/$/, '') === expected.pathname.replace(/\/$/, ''));
  } catch { return false; }
}
function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function boundedInteger(value: unknown, min: number, max: number, fallback: number): number { const parsed = value === undefined ? fallback : Number(value); if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new OperatorError('TASK_BUDGET_INVALID', 'Task budget is invalid.'); return parsed; }
function boundedText(value: unknown, max: number, label: string): string { if (typeof value !== 'string' || !value || value.length > max || value.includes('\0')) throw new OperatorError('TASK_INPUT_INVALID', `${label} is invalid.`); return value; }
function boundedTextArray(value: unknown, maxItems: number, maxText: number, label: string): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new OperatorError('TASK_INPUT_INVALID', `${label} is invalid.`);
  return value.map((entry, index) => boundedText(entry, maxText, `${label}[${index}]`));
}
