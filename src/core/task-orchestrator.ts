import crypto from 'node:crypto';
import path from 'node:path';
import type { OperatorRuntime } from './runtime.ts';
import type { ActionRequest, ActionResult, ActionRisk, PermissionProfile } from './types.ts';
import type { TaskActionRecord, TaskCapsule, TaskExecution, TaskObservationDomain } from './task.ts';
import { addTaskNode, createTask, finalizeTask, setNodeState } from './task.ts';
import { TaskStore } from './task-store.ts';
import { capabilityRiskRule } from './capability-policy.ts';
import { evidence } from './evidence.ts';
import { OperatorError } from './errors.ts';
import { normalizeMachineObservation, observationDomain } from './machine-state.ts';

export type UiaTaskOperation = 'invoke' | 'set_value' | 'focus' | 'select' | 'expand' | 'collapse' | 'scroll' | 'activate_window';
export type UiaTaskSelector = { name?: string; automationId?: string; className?: string; controlType?: string; processId?: number };

export type SemanticTaskGoal =
  | { kind: 'controlled-file-change'; root: string; path: string; content: string }
  | { kind: 'trusted-project-command'; root: string; commandKind: 'build' | 'test' | 'lint' }
  | { kind: 'browser-navigation'; url: string; targetId?: string }
  | {
      kind: 'app-operation'; operation: UiaTaskOperation; selector: UiaTaskSelector;
      value?: string; horizontalAmount?: string; verticalAmount?: string;
      verifySelector?: UiaTaskSelector; waitMs?: number;
    };

export interface TaskPlannerContext {
  task: TaskCapsule;
  goal: SemanticTaskGoal;
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
  accept(context: TaskPlannerContext, step: Extract<PlannerDecision, { type: 'step' }>, observation: TaskObservation): void;
  fallback?(context: TaskPlannerContext, step: Extract<PlannerDecision, { type: 'step' }>, observation: TaskObservation): boolean;
}

export interface SubmitTaskOptions {
  objective: string;
  authorizedScope: string[];
  prohibitedScope?: string[];
  successConditions: string[];
  goal: SemanticTaskGoal;
  maxSteps?: number;
  maxAttemptsPerStep?: number;
  timeoutMs?: number;
}

export class TaskOrchestrator {
  #runtime: OperatorRuntime;
  #store: TaskStore;
  #permissions: PermissionProfile;
  #planners: Map<string, TaskPlanner>;
  #active = new Map<string, Promise<TaskCapsule>>();
  #executeAction: (action: ActionRequest, permissions: PermissionProfile) => Promise<ActionResult>;

  constructor(options: {
    runtime: OperatorRuntime;
    store: TaskStore;
    permissions: PermissionProfile;
    planners?: TaskPlanner[];
    executeAction?: (action: ActionRequest, permissions: PermissionProfile) => Promise<ActionResult>;
  }) {
    this.#runtime = options.runtime;
    this.#store = options.store;
    const planners = options.planners ?? [new SemanticTaskPlanner()];
    this.#planners = new Map(planners.map((planner) => [planner.id, planner]));
    this.#permissions = structuredClone(options.permissions);
    this.#executeAction = options.executeAction ?? ((action, permissions) => this.#runtime.execute(action, permissions));
  }

  async submit(input: SubmitTaskOptions): Promise<TaskCapsule> {
    const goalKind = input.goal && typeof input.goal === 'object' ? String((input.goal as { kind?: unknown }).kind ?? '') : '';
    const goal = parseGoal(input.goal, goalKind);
    const planner = [...this.#planners.values()].find((candidate) => candidate.supports(goal));
    if (!planner) throw new OperatorError('TASK_PLANNER_UNAVAILABLE', `No task planner supports ${goal.kind}.`);
    const task = createTask({
      userObjective: boundedText(input.objective, 16_384, 'objective'),
      interpretedObjective: `${goal.kind}:${boundedText(input.objective, 16_384, 'objective')}`,
      authorizedScope: boundedTextArray(input.authorizedScope, 1000, 4096, 'authorizedScope'),
      prohibitedScope: boundedTextArray(input.prohibitedScope ?? [], 1000, 4096, 'prohibitedScope'),
      successConditions: boundedTextArray(input.successConditions, 1000, 16_384, 'successConditions')
    });
    task.execution = {
      schemaVersion: 1,
      plannerId: planner.id,
      goalKind: goal.kind,
      plannerState: { goal: structuredClone(goal), phase: 'start' },
      maxSteps: boundedInteger(input.maxSteps, 1, 100, 20),
      maxAttemptsPerStep: boundedInteger(input.maxAttemptsPerStep, 1, 5, 2),
      timeoutMs: boundedInteger(input.timeoutMs, 100, 60 * 60_000, 10 * 60_000),
      stepCount: 0,
      records: []
    };
    await this.#store.put(task);
    return task;
  }

  async run(taskId: string, approvedActionIds: string[] = []): Promise<TaskCapsule> {
    const active = this.#active.get(taskId);
    if (active) return await active;
    const promise = this.#runWithLease(taskId, approvedActionIds).finally(() => this.#active.delete(taskId));
    this.#active.set(taskId, promise);
    return await promise;
  }

  async #runWithLease(taskId: string, approvedActionIds: string[]): Promise<TaskCapsule> {
    const lease = await this.#store.acquireExecutionLease(taskId);
    try { return await this.#run(taskId, approvedActionIds, lease.assertOwned); }
    finally { await lease.release(); }
  }

  async #run(taskId: string, approvedActionIds: string[], assertLease: () => Promise<void>): Promise<TaskCapsule> {
    let task = await this.#store.get(taskId);
    if (!task.execution) throw new OperatorError('TASK_EXECUTION_MISSING', 'Task has no execution metadata.');
    if (['VERIFIED', 'CANCELLED', 'FAILED'].includes(task.state)) return task;
    if (task.state === 'PAUSED') return task;
    const execution = task.execution;
    const planner = this.#planners.get(execution.plannerId);
    if (!planner) throw new OperatorError('TASK_PLANNER_UNAVAILABLE', `Task planner ${execution.plannerId} is unavailable.`);
    const goal = parseGoal(execution.plannerState.goal, execution.goalKind);
    if (!execution.startedAt) {
      execution.startedAt = new Date().toISOString();
      execution.deadlineAt = new Date(Date.now() + execution.timeoutMs).toISOString();
    }
    task.state = 'RUNNING';
    await assertLease();
    await this.#store.put(task);

    while (true) {
      task = await this.#store.get(task.id);
      await assertLease();
      if (task.state === 'PAUSED' || task.state === 'CANCELLED') return task;
      const current = task.execution!;
      if (Date.now() >= Date.parse(current.deadlineAt!)) return await this.#fail(task, 'TASK_TIMEOUT', 'Task execution exceeded its bounded deadline.', assertLease);
      this.#markInterrupted(current);
      const context = { task, goal };
      let decision: PlannerDecision;
      try { decision = planner.next(context); }
      catch (error) { return await this.#fail(task, 'TASK_PLANNER_FAILED', error instanceof Error ? error.message : String(error), assertLease); }
      if (decision.type === 'complete') {
        task.evidence.push(evidence('task_completion', 'pass', decision.message));
        finalizeTask(task);
        await assertLease();
        await this.#store.put(task);
        return task;
      }
      if (current.stepCount >= current.maxSteps) return await this.#fail(task, 'TASK_STEP_BUDGET_EXHAUSTED', 'Task execution exhausted its bounded step budget.', assertLease);

      const inputHash = sha256(canonicalJson(decision.input));
      if (detectPlannerLoop(current.records, decision.key, inputHash)) {
        return await this.#fail(task, 'TASK_LOOP_DETECTED', `Planner repeated the ${decision.key} cycle without progress.`, assertLease);
      }
      const previous = [...current.records].reverse().find((record) => record.stepKey === decision.key && record.inputHash === inputHash);
      const priorAttempts = current.records.filter((record) => record.stepKey === decision.key && record.inputHash === inputHash && record.state !== 'BLOCKED').length;
      if (priorAttempts >= current.maxAttemptsPerStep) return await this.#fail(task, 'TASK_RETRY_BUDGET_EXHAUSTED', `Step ${decision.key} exhausted its retry budget.`, assertLease);
      let risk: ActionRisk;
      try { risk = await this.#canonicalRisk(decision.capability, decision.input); }
      catch (error) { return await this.#fail(task, 'TASK_RISK_RESOLUTION_FAILED', error instanceof Error ? error.message : String(error), assertLease); }
      const blockedReplay = previous?.state === 'BLOCKED' ? previous : undefined;
      const attempt = blockedReplay?.attempt ?? priorAttempts + 1;
      const actionId = blockedReplay?.actionId ?? deterministicActionId(task.id, decision.key, attempt, inputHash);
      const node = task.nodes.find((candidate) => candidate.title === decision.title) ?? addTaskNode(task, decision.title);
      setNodeState(task, node.id, 'RUNNING');
      const record: TaskActionRecord = blockedReplay ?? {
        stepKey: decision.key, actionId, capability: decision.capability, risk, inputHash, attempt,
        state: 'STARTED', startedAt: new Date().toISOString(), evidence: []
      };
      if (!blockedReplay) current.records.push(record);
      else { record.state = 'STARTED'; record.startedAt = new Date().toISOString(); delete record.finishedAt; delete record.errorCode; record.evidence = []; }
      current.stepCount += 1;
      await assertLease();
      await this.#store.put(task);

      const action: ActionRequest = {
        id: actionId, taskId: task.id, capability: decision.capability, risk,
        input: structuredClone(decision.input), provenance: { kind: 'trusted_policy', source: `task-planner:${planner.id}` },
        ...(decision.target ? { target: decision.target } : {})
      };
      const permissions = approvedActionIds.length === 0 ? this.#permissions : {
        ...this.#permissions,
        approvedActionIds: [...new Set([...(this.#permissions.approvedActionIds ?? []), ...approvedActionIds])]
      };
      let result: ActionResult;
      try { result = await this.#executeAction(action, permissions); }
      catch (error) {
        result = {
          ok: false, capability: action.capability, provider: 'task-executor', evidence: [], durationMs: 0,
          error: { code: 'TASK_EXECUTOR_EXCEPTION', message: error instanceof Error ? error.message : String(error), retryable: false }
        };
      }
      const latest = await this.#store.get(task.id);
      await assertLease();
      const controlState = latest.state === 'PAUSED' || latest.state === 'CANCELLED' ? latest.state : undefined;
      task = latest;
      const latestExecution = task.execution!;
      const latestRecord = latestExecution.records.find((candidate) => candidate.actionId === actionId);
      if (!latestRecord) return await this.#fail(task, 'TASK_STATE_CONFLICT', 'Persisted action record disappeared during execution.', assertLease);
      const latestNode = task.nodes.find((candidate) => candidate.title === decision.title);
      if (!latestNode) return await this.#fail(task, 'TASK_STATE_CONFLICT', 'Persisted task node disappeared during execution.', assertLease);
      const observation = observe(result);
      const normalizedObservation = normalizeMachineObservation(action, result, observation.channel);
      latestRecord.finishedAt = new Date().toISOString();
      latestRecord.evidence = result.evidence;
      latestRecord.observation = normalizedObservation;
      latestNode.evidence.push(...result.evidence);
      task.evidence.push(...result.evidence);
      if (result.ok) {
        try {
          planner.accept({ task, goal }, decision, observation);
        } catch (error) {
          latestRecord.state = 'FAILED';
          latestRecord.errorCode = 'TASK_POSTCONDITION_FAILED';
          setNodeState(task, latestNode.id, 'FAILED');
          return await this.#fail(task, 'TASK_POSTCONDITION_FAILED', error instanceof Error ? error.message : String(error), assertLease);
        }
        latestRecord.state = 'SUCCEEDED';
        setNodeState(task, latestNode.id, 'VERIFIED');
        if (controlState) task.state = controlState;
        await assertLease();
        await this.#store.put(task);
        if (controlState) return task;
        continue;
      }

      latestRecord.errorCode = result.error?.code ?? 'EXECUTION_FAILED';
      if (latestRecord.errorCode === 'APPROVAL_REQUIRED') {
        latestRecord.state = 'BLOCKED';
        task.state = 'BLOCKED';
        setNodeState(task, latestNode.id, 'BLOCKED');
        await assertLease();
        await this.#store.put(task);
        return task;
      }
      if (planner.fallback?.({ task, goal }, decision, observation)) {
        latestRecord.state = 'FAILED';
        setNodeState(task, latestNode.id, 'SKIPPED');
        if (controlState) task.state = controlState;
        await assertLease();
        await this.#store.put(task);
        if (controlState) return task;
        continue;
      }
      latestRecord.state = 'FAILED';
      setNodeState(task, latestNode.id, 'FAILED');
      if (controlState) {
        task.state = controlState;
        await assertLease();
        await this.#store.put(task);
        return task;
      }
      if (result.error?.retryable === true && risk === 'read') { await assertLease(); await this.#store.put(task); continue; }
      return await this.#fail(task, latestRecord.errorCode, result.error?.message ?? 'Task action failed.', assertLease);
    }
  }

  async pause(taskId: string): Promise<TaskCapsule> { return await this.#setControlState(taskId, 'PAUSED'); }
  async cancel(taskId: string): Promise<TaskCapsule> { return await this.#setControlState(taskId, 'CANCELLED'); }
  async resume(taskId: string, approvedActionIds: string[] = []): Promise<TaskCapsule> {
    const task = await this.#store.get(taskId);
    if (!['PAUSED', 'BLOCKED'].includes(task.state)) throw new OperatorError('TASK_NOT_RESUMABLE', 'Only paused or blocked tasks can resume.');
    task.state = 'PENDING';
    for (const node of task.nodes) if (node.state === 'BLOCKED') node.state = 'PENDING';
    await this.#store.put(task);
    return await this.run(taskId, approvedActionIds);
  }

  async #setControlState(taskId: string, state: 'PAUSED' | 'CANCELLED'): Promise<TaskCapsule> {
    const task = await this.#store.get(taskId);
    if (['VERIFIED', 'FAILED', 'CANCELLED'].includes(task.state)) throw new OperatorError('TASK_TERMINAL', 'Terminal task state cannot change.');
    task.state = state;
    task.updatedAt = new Date().toISOString();
    await this.#store.put(task);
    return task;
  }

  async #canonicalRisk(capability: string, input: Record<string, unknown>): Promise<ActionRisk> {
    const rule = capabilityRiskRule(capability);
    if (rule !== 'dynamic') return rule;
    return await this.#runtime.router.resolveRisk({ id: 'task-risk-probe', capability, risk: 'read', input, provenance: { kind: 'trusted_policy' } });
  }

  #markInterrupted(execution: TaskExecution): void {
    for (const record of execution.records) if (record.state === 'STARTED') {
      record.state = 'INTERRUPTED';
      record.finishedAt = new Date().toISOString();
      record.errorCode = 'TASK_ACTION_INTERRUPTED';
    }
  }

  async #fail(task: TaskCapsule, code: string, message: string, assertLease?: () => Promise<void>): Promise<TaskCapsule> {
    task.state = 'FAILED';
    task.failures.push({ at: new Date().toISOString(), code, message });
    task.evidence.push(evidence('task_failure', 'fail', message, { code }));
    task.updatedAt = new Date().toISOString();
    await assertLease?.();
    await this.#store.put(task);
    return task;
  }
}

export class SemanticTaskPlanner implements TaskPlanner {
  readonly id = 'operator.semantic.v1';
  supports(goal: SemanticTaskGoal): boolean { return ['controlled-file-change', 'trusted-project-command', 'browser-navigation', 'app-operation'].includes(goal.kind); }

  next({ task, goal }: TaskPlannerContext): PlannerDecision {
    const state = task.execution!.plannerState;
    const phase = String(state.phase ?? 'start');
    if (goal.kind === 'controlled-file-change') {
      if (phase === 'start') return { type: 'step', key: 'list-parent', title: 'Observe target directory', capability: 'file.list', input: { path: path.dirname(goal.path) || '.' } };
      if (phase === 'create') return { type: 'step', key: 'create-file', title: 'Create requested file', capability: 'file.create', input: { path: goal.path, content: goal.content } };
      if (phase === 'read') return { type: 'step', key: 'verify-file', title: 'Verify exact file content', capability: 'file.read', input: { path: goal.path, encoding: 'utf8' } };
      if (phase === 'git') return { type: 'step', key: 'inspect-git', title: 'Verify Git observes the file', capability: 'git.status', input: { cwd: goal.root } };
      return { type: 'complete', message: 'Controlled file task satisfied exact-content and Git-state postconditions.' };
    }
    if (goal.kind === 'trusted-project-command') {
      if (phase === 'start') return { type: 'step', key: 'inspect-project', title: 'Inspect project semantics', capability: 'project.inspect', input: { path: goal.root } };
      if (phase === 'commands') return { type: 'step', key: 'inspect-commands', title: 'Discover trusted project commands', capability: 'project.command.inspect', input: { path: goal.root } };
      if (phase === 'run') return { type: 'step', key: 'run-command', title: 'Execute trusted project command', capability: 'project.command.run', input: { path: goal.root, commandId: state.commandId, expectedRisk: state.commandRisk } };
      return { type: 'complete', message: 'Trusted project command completed with its registered postcondition validation.' };
    }
    if (goal.kind === 'app-operation') {
      const selector = phase === 'verify' ? (goal.verifySelector ?? goal.selector) : goal.selector;
      const inspectInput = { selector, maxNodes: 1, maxDepth: 0, waitMs: goal.waitMs ?? 0 };
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
      return { type: 'complete', message: 'Application operation satisfied semantic targeting and deterministic postcondition verification.' };
    }
    if (phase === 'start') return { type: 'step', key: 'inspect-browser', title: 'Inspect semantic browser state', capability: 'browser.inspect', input: {} };
    if (phase === 'navigate') return { type: 'step', key: 'navigate-browser', title: 'Navigate the selected browser target', capability: 'browser.navigate', input: { targetId: state.targetId, url: goal.url }, target: goal.url };
    if (phase === 'verify') return { type: 'step', key: 'verify-browser', title: 'Verify semantic browser destination', capability: 'browser.inspect', input: { targetId: state.targetId }, target: goal.url };
    return { type: 'complete', message: 'Browser navigation satisfied semantic destination postconditions.' };
  }

  accept({ task, goal }: TaskPlannerContext, step: Extract<PlannerDecision, { type: 'step' }>, result: TaskObservation): void {
    const state = task.execution!.plannerState;
    if (goal.kind === 'controlled-file-change') {
      if (step.key === 'list-parent') state.phase = 'create';
      else if (step.key === 'create-file') state.phase = 'read';
      else if (step.key === 'verify-file') {
        const output = asRecord(result.output);
        if (output.content !== goal.content) throw new OperatorError('TASK_CONTENT_MISMATCH', 'File content did not match the requested exact content.');
        state.phase = 'git';
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
    if (step.key === 'navigate-browser' && result.error?.code === 'BROWSER_TARGET_NOT_FOUND') {
      task.execution!.plannerState.phase = 'start';
      delete task.execution!.plannerState.targetId;
      task.evidence.push(evidence('strategy_fallback', 'info', 'Browser target disappeared; switched to semantic target re-discovery.'));
      return true;
    }
    if (step.key === 'operate-app-target' && ['UIA_ELEMENT_NOT_FOUND', 'UIA_WAIT_TIMEOUT'].includes(result.error?.code ?? '')) {
      task.execution!.plannerState.phase = 'start';
      delete task.execution!.plannerState.targetIdentity;
      task.evidence.push(evidence('strategy_fallback', 'info', 'UIA target disappeared or timed out; switched to bounded semantic target re-discovery.'));
      return true;
    }
    return false;
  }
}

function parseGoal(input: unknown, expectedKind: string): SemanticTaskGoal {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new OperatorError('TASK_GOAL_INVALID', 'Stored task goal is invalid.');
  const goal = structuredClone(input) as SemanticTaskGoal;
  if (goal.kind !== expectedKind) throw new OperatorError('TASK_GOAL_INVALID', 'Stored task goal kind does not match execution metadata.');
  if (goal.kind === 'controlled-file-change') {
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
  } else if (goal.kind === 'browser-navigation') {
    const rawUrl = boundedText(goal.url, 16_384, 'goal URL');
    let url: URL;
    try { url = new URL(rawUrl); } catch { throw new OperatorError('TASK_GOAL_INVALID', 'Browser goal requires a valid absolute URL.'); }
    if (!['http:', 'https:'].includes(url.protocol)) throw new OperatorError('TASK_GOAL_INVALID', 'Browser goal permits only HTTP(S) destinations.');
    if (url.username || url.password) throw new OperatorError('TASK_GOAL_INVALID', 'Browser goal URL must not contain credentials.');
    goal.url = url.toString();
    if (goal.targetId !== undefined) goal.targetId = boundedText(goal.targetId, 256, 'browser targetId');
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
  } else throw new OperatorError('TASK_GOAL_INVALID', 'Task goal kind is unsupported.');
  return goal;
}

const UIA_TASK_OPERATIONS: readonly UiaTaskOperation[] = ['invoke', 'set_value', 'focus', 'select', 'expand', 'collapse', 'scroll', 'activate_window'];
const UIA_SCROLL_AMOUNTS = ['large_decrement', 'small_decrement', 'none', 'large_increment', 'small_increment'] as const;

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

function deterministicActionId(taskId: string, stepKey: string, attempt: number, inputHash: string): string {
  return `task-${sha256(`${taskId}\0${stepKey}\0${attempt}\0${inputHash}`)}`;
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  const input = value as Record<string, unknown>;
  return `{${Object.keys(input).sort().filter((key) => input[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonicalJson(input[key])}`).join(',')}}`;
}
function sha256(value: string): string { return crypto.createHash('sha256').update(value).digest('hex'); }
function observe(result: ActionResult): TaskObservation {
  return {
    channel: 'semantic', domain: observationDomain(result.capability, result.provider), observedAt: new Date().toISOString(),
    ok: result.ok, capability: result.capability, provider: result.provider,
    ...(result.output === undefined ? {} : { output: structuredClone(result.output) }),
    evidence: structuredClone(result.evidence),
    ...(result.error === undefined ? {} : { error: structuredClone(result.error) })
  };
}
function detectPlannerLoop(records: TaskActionRecord[], stepKey: string, inputHash: string): boolean {
  const signatures = records.filter((record) => record.state !== 'BLOCKED').map((record) => `${record.stepKey}:${record.inputHash}`);
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
