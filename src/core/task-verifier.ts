import crypto from 'node:crypto';
import path from 'node:path';
import { canonicalJson } from './action-identity.ts';
import { evidence } from './evidence.ts';
import type { Evidence } from './types.ts';
import type { TaskActionRecord, TaskCapsule } from './task.ts';
import { VerificationKernel } from './verification-kernel.ts';
import { postgresSelectActionInput } from './semantic-task-input.ts';
import { assertTaskMachineState, type TaskStateAssertion } from './task-state-assertion.ts';

export interface TaskVerificationBundle {
  version: 1;
  taskId: string;
  plannerId: string;
  goalKind: string;
  successConditions: string[];
  requiredNodes: number;
  verifiedNodes: number;
  skippedNodes: number;
  actionRecords: number;
  succeededActions: number;
  interruptedActions: number;
  stateVersions: string[];
  checks: Array<{ name: string; ok: boolean; detail: string }>;
  digest: string;
}

export interface TaskOutcomeTruth {
  supported: boolean;
  ok: boolean;
  detail: string;
  stateVersions: string[];
}

export function verifyGoalOutcomeTruth(task: TaskCapsule): TaskOutcomeTruth {
  return structuredOutcomeTruth(task);
}

export function verifyTaskCompletion(task: TaskCapsule): { ok: boolean; bundle: TaskVerificationBundle; evidence: Evidence } {
  const execution = task.execution;
  const checks: TaskVerificationBundle['checks'] = [];
  const outcomeTruth = structuredOutcomeTruth(task);
  const required = task.nodes.filter((node) => node.required);
  const unresolvedNodes = required.filter((node) => node.state !== 'VERIFIED' && node.state !== 'SKIPPED');
  const activeRecords = execution?.records.filter((record) => record.state === 'STARTED' || record.state === 'BLOCKED') ?? [];
  const failedRequired = required.filter((node) => node.state === 'FAILED' || node.state === 'BLOCKED');
  const conditionsPresent = task.successConditions.length > 0;
  const keyedNodeRecordMismatches = required.filter((node) => {
    if (!node.key && !node.stepKey && !node.actionId) return false;
    const matching = execution?.records.filter((record) =>
      node.actionId ? record.actionId === node.actionId : record.stepKey === (node.stepKey ?? node.key)
    ) ?? [];
    if (node.state === 'VERIFIED') return !matching.some((record) => record.state === 'SUCCEEDED');
    if (node.state === 'SKIPPED') return !matching.some((record) => record.state === 'FAILED' || record.state === 'INTERRUPTED');
    return false;
  });
  const plannerTerminal = builtinPlannerStateIsTerminal(task);
  const semanticObservationPresent = execution?.records.some((record) => record.observation !== undefined) ?? false;

  checks.push({
    name: 'required-nodes-resolved',
    ok: unresolvedNodes.length === 0 && failedRequired.length === 0,
    detail: unresolvedNodes.length === 0 && failedRequired.length === 0
      ? 'Every required graph node is verified or explicitly skipped by a recorded strategy transition.'
      : `${unresolvedNodes.length + failedRequired.length} required graph node(s) remain unresolved or failed.`
  });
  checks.push({
    name: 'no-inflight-actions',
    ok: activeRecords.length === 0,
    detail: activeRecords.length === 0 ? 'No action remains STARTED or BLOCKED.' : `${activeRecords.length} action record(s) remain in-flight.`
  });
  checks.push({
    name: 'planner-contract',
    ok: Boolean(execution?.plannerId && execution.goalKind) && plannerTerminal,
    detail: execution
      ? plannerTerminal
        ? `Planner ${execution.plannerId} is in a terminal persisted state for goal kind ${execution.goalKind}.`
        : `Planner ${execution.plannerId} reported completion without a terminal persisted state.`
      : 'Execution metadata is missing.'
  });
  checks.push({
    name: 'graph-record-integrity',
    ok: keyedNodeRecordMismatches.length === 0,
    detail: keyedNodeRecordMismatches.length === 0
      ? 'Every keyed verified/skipped graph node reconciles with a durable action record.'
      : `${keyedNodeRecordMismatches.length} keyed graph node(s) do not reconcile with durable action records.`
  });
  checks.push({
    name: 'declared-success-conditions',
    ok: conditionsPresent,
    detail: conditionsPresent
      ? `${task.successConditions.length} user-declared condition(s) are present. Their prose is not trusted as proof; machine truth is evaluated by the typed goal-outcome contract.`
      : 'No success condition was declared.'
  });
  checks.push({
    name: 'typed-goal-outcome-truth',
    ok: outcomeTruth.supported ? outcomeTruth.ok : true,
    detail: outcomeTruth.supported
      ? outcomeTruth.detail
      : 'No built-in typed outcome contract applies to this extensible/custom planner; graph, action-record, and provider evidence checks remain authoritative.'
  });
  if (outcomeTruth.supported) {
    for (let index = 0; index < task.successConditions.length; index += 1) {
      checks.push({
        name: `declared-condition-${index + 1}`,
        ok: outcomeTruth.ok,
        detail: outcomeTruth.ok
          ? `Declared condition ${index + 1} is accepted only because the persisted typed goal outcome is independently true in durable machine evidence.`
          : `Declared condition ${index + 1} is not accepted because the typed goal outcome is not proven true.`
      });
    }
  }
  checks.push({
    name: 'evidence-present',
    ok: semanticObservationPresent || (execution?.records.some((record) => record.evidence.length > 0) ?? false),
    detail: semanticObservationPresent
      ? 'At least one durable semantic/visual machine observation supports completion.'
      : 'Completion requires durable provider evidence or a machine observation; planner completion text alone is insufficient.'
  });

  const stateVersions = [...new Set(
    (execution?.records ?? [])
      .map((record) => record.observation?.schemaVersion === 2 ? record.observation.stateVersion : undefined)
      .filter((value): value is string => Boolean(value))
  )].sort();
  const base = {
    version: 1 as const,
    taskId: task.id,
    plannerId: execution?.plannerId ?? 'missing',
    goalKind: execution?.goalKind ?? 'missing',
    successConditions: [...task.successConditions],
    requiredNodes: required.length,
    verifiedNodes: required.filter((node) => node.state === 'VERIFIED').length,
    skippedNodes: required.filter((node) => node.state === 'SKIPPED').length,
    actionRecords: execution?.records.length ?? 0,
    succeededActions: execution?.records.filter((record) => record.state === 'SUCCEEDED').length ?? 0,
    interruptedActions: execution?.records.filter((record) => record.state === 'INTERRUPTED').length ?? 0,
    stateVersions,
    checks
  };
  const { checks: _contractChecks, ...contract } = base;
  const receipt = new VerificationKernel().verify({
    subjectKind: 'task',
    subjectId: task.id,
    contract,
    checks
  });
  const digest = receipt.digest;
  const bundle: TaskVerificationBundle = { ...base, digest };
  const ok = receipt.verified;
  return {
    ok,
    bundle,
    evidence: evidence(
      'independent_task_verification',
      ok ? 'pass' : 'fail',
      ok ? 'Independent verifier accepted the completed task graph.' : 'Independent verifier rejected task completion.',
      {
        digest,
        requiredNodes: bundle.requiredNodes,
        verifiedNodes: bundle.verifiedNodes,
        skippedNodes: bundle.skippedNodes,
        actionRecords: bundle.actionRecords,
        succeededActions: bundle.succeededActions,
        stateVersionCount: bundle.stateVersions.length,
        checks: checks.map(({ name, ok, detail }) => ({ name, ok, detail }))
      }
    )
  };
}



function structuredOutcomeTruth(task: TaskCapsule): TaskOutcomeTruth {
  const execution = task.execution;
  if (!execution) return outcome(false, false, 'Execution metadata is missing.', []);
  const goal = asRecord(execution.plannerState.goal);
  if (execution.plannerId === 'operator.semantic.v1') {
    return evaluateAtomicGoal(goal, execution.records, '');
  }
  if (execution.plannerId === 'operator.semantic-workflow.v1') {
    const steps = Array.isArray(goal.steps) ? goal.steps.map(asRecord) : [];
    if (steps.length === 0) return outcome(true, false, 'Semantic workflow has no typed child goals to verify.', []);
    const results = steps.map((child, index) => evaluateAtomicGoal(child, execution.records, `workflow:${index}:`));
    const unsupported = results.find((item) => !item.supported);
    if (unsupported) return outcome(true, false, `Workflow child outcome is not independently verifiable: ${unsupported.detail}`, mergeVersions(results));
    const failed = results.find((item) => !item.ok);
    return outcome(true, !failed, failed
      ? `At least one of ${steps.length} typed workflow outcomes is not proven: ${failed.detail}`
      : `All ${steps.length} typed workflow outcomes are independently proven from durable machine observations.`, mergeVersions(results));
  }
  if (execution.plannerId === 'operator.project-quality-gate.v1') {
    return evaluateQualityGate(execution.records, execution.plannerState);
  }
  if (execution.plannerId === 'operator.autonomous-workflow.v1') {
    const steps = Array.isArray(goal.steps) ? goal.steps.map(asRecord) : [];
    if (steps.length === 0) return outcome(true, false, 'Autonomous workflow has no bounded steps to verify.', []);
    const records: Array<TaskActionRecord | undefined> = [];
    for (let index = 0; index < steps.length; index += 1) {
      const record = lastSucceeded(execution.records, `autonomous:${index}:verify`);
      records.push(record);
      if (!record?.observation || record.observation.schemaVersion !== 2) return outcome(true, false, `Autonomous step ${index + 1} lacks durable verification state.`, mergeRecordVersions(records));
      const verify = asRecord(steps[index]!.verify);
      const assertions = Array.isArray(verify.assertions) ? verify.assertions as TaskStateAssertion[] : [];
      try { assertTaskMachineState(record.observation.importantState, assertions); }
      catch { return outcome(true, false, `Autonomous step ${index + 1} machine-state assertions are not satisfied.`, mergeRecordVersions(records)); }
    }
    return outcome(true, true, `All ${steps.length} autonomous steps are independently proven by read-only durable machine observations.`, mergeRecordVersions(records));
  }
  return outcome(false, false, 'Planner does not use a built-in typed goal-outcome contract.', []);
}

function evaluateAtomicGoal(goal: Record<string, unknown>, records: TaskActionRecord[], prefix: string): TaskOutcomeTruth {
  const kind = String(goal.kind ?? '');
  if (kind === 'controlled-file-change') {
    const fileRecord = lastSucceeded(records, `${prefix}verify-file`);
    const gitRecord = lastSucceeded(records, `${prefix}inspect-git`);
    const fileState = observationState(fileRecord);
    const gitState = observationState(gitRecord);
    const content = typeof goal.content === 'string' ? goal.content : undefined;
    const root = typeof goal.root === 'string' ? goal.root : undefined;
    const target = typeof goal.path === 'string' ? goal.path : undefined;
    const expectedSha = content === undefined ? undefined : sha256(content);
    const relative = root && target ? path.relative(root, target).replace(/\\/g, '/').replace(/^\.\//, '') : undefined;
    const expectedPathHash = relative ? sha256(relative) : undefined;
    const gitPathHashes = Array.isArray(gitState.gitPathHashes) ? gitState.gitPathHashes.map(String) : [];
    const ok = Boolean(fileRecord && gitRecord && expectedSha && expectedPathHash
      && fileState.sha256 === expectedSha && gitPathHashes.includes(expectedPathHash));
    return outcome(true, ok, ok
      ? 'Exact requested file bytes and Git visibility are independently proven by fresh durable machine observations.'
      : 'Completion lacks either the exact file-content digest or fresh Git visibility for the requested path.', mergeRecordVersions([fileRecord, gitRecord]));
  }
  if (kind === 'trusted-project-command') {
    const record = lastSucceeded(records, `${prefix}run-command`);
    const state = observationState(record);
    const expectedKind = String(goal.commandKind ?? '');
    const ok = Boolean(record && expectedKind && state.commandKind === expectedKind && state.exitCode === 0 && state.validationPassed !== false);
    return outcome(true, ok, ok
      ? 'Trusted command kind, zero exit status, and registered artifact validation are proven by durable execution evidence.'
      : 'Trusted command completion is missing a matching zero-exit validated machine observation.', versions(record));
  }
  if (kind === 'browser-navigation') {
    const record = lastSucceededAny(records, [`${prefix}verify-browser`, `${prefix}inspect-browser`]);
    const state = observationState(record);
    const expectedDigest = typeof goal.url === 'string' ? browserDestinationDigest(goal.url) : undefined;
    const expectedTargetId = typeof goal.targetId === 'string' ? goal.targetId : undefined;
    const targets = Array.isArray(state.browserTargets) ? state.browserTargets.map(asRecord) : [];
    const matched = targets.some((target) => target.destinationDigest === expectedDigest
      && (!expectedTargetId || target.id === expectedTargetId)
      && (expectedTargetId || target.type === undefined || target.type === 'page'));
    const ok = Boolean(record && expectedDigest && matched);
    return outcome(true, ok, ok
      ? 'A fresh browser observation proves the requested logical destination without trusting planner completion text.'
      : 'No fresh browser observation proves the requested destination and target identity.', versions(record));
  }
  if (kind === 'docker-lifecycle') {
    const record = lastSucceededAny(records, [`${prefix}verify-docker-project`, `${prefix}inspect-docker-project`]);
    const state = observationState(record);
    const services = Array.isArray(goal.services) ? goal.services.map(String) : [];
    const expectedState = goal.operation === 'stop' ? 'exited' : 'running';
    const observed = Array.isArray(state.services) ? state.services.map(asRecord) : [];
    const ok = Boolean(record && state.scope === 'project' && services.length > 0 && services.every((service) => {
      const item = observed.find((candidate) => candidate.service === service);
      const states = Array.isArray(item?.states) ? item!.states.map(String) : [];
      return states.length > 0 && states.every((value) => value === expectedState);
    }));
    return outcome(true, ok, ok
      ? `Fresh project-scoped Docker inspection proves every requested service is ${expectedState}.`
      : `Fresh Docker inspection does not prove every requested service reached ${expectedState}.`, versions(record));
  }
  if (kind === 'postgres-select') {
    const record = lastSucceeded(records, `${prefix}select-postgres-rows`);
    const state = observationState(record);
    const expectedInput = postgresSelectActionInput({
      root: String(goal.root ?? ''),
      profileId: String(goal.profileId ?? ''),
      schema: goal.schema === undefined ? undefined : String(goal.schema),
      table: String(goal.table ?? ''),
      columns: Array.isArray(goal.columns) ? goal.columns.map(String) : [],
      filters: Array.isArray(goal.filters) ? goal.filters : [],
      orderBy: Array.isArray(goal.orderBy) ? goal.orderBy : [],
      limit: Number(goal.limit ?? 100),
      offset: Number(goal.offset ?? 0),
      timeoutMs: Number(goal.timeoutMs ?? 5_000)
    });
    const expectedColumns = Array.isArray(goal.columns) && goal.columns.length > 0 ? goal.columns.map(String) : ['*'];
    const actualColumns = Array.isArray(state.columns) ? state.columns.map(String) : [];
    const rowCount = Number(state.rowCount);
    const limit = Number(goal.limit ?? 100);
    const expectedInputHash = sha256(canonicalJson(expectedInput));
    const predicates = {
      record: Boolean(record),
      inputHash: record?.inputHash === expectedInputHash,
      profile: state.profileId === goal.profileId,
      schema: state.schema === (goal.schema ?? 'public'),
      table: state.table === goal.table,
      limit: Number(state.limit) === limit,
      offset: Number(state.offset) === Number(goal.offset ?? 0),
      rowCount: Number.isSafeInteger(rowCount) && rowCount >= 0 && rowCount <= limit,
      columns: canonicalJson(actualColumns) === canonicalJson(expectedColumns)
    };
    const ok = Object.values(predicates).every(Boolean);
    const failedPredicates = Object.entries(predicates).filter(([, passed]) => !passed).map(([name]) => name);
    return outcome(true, ok, ok
      ? 'Bounded PostgreSQL SELECT is proven against the exact requested input contract and durable result metadata.'
      : `PostgreSQL result evidence does not match the exact typed SELECT contract: ${failedPredicates.join(', ')}.`, versions(record));
  }
  if (kind === 'app-operation') {
    const physical = lastSucceeded(records, `${prefix}operate-app-physical-fallback`);
    if (physical) {
      const postcondition = asRecord(observationState(physical).postcondition);
      const ok = postcondition.dispatched === true
        && postcondition.captureLeaseConsumed === true
        && postcondition.afterCaptured === true
        && typeof postcondition.afterSha256 === 'string'
        && /^[0-9a-f]{64}$/i.test(postcondition.afterSha256);
      return outcome(true, ok, ok
        ? 'Capture-bound physical fallback proves dispatch, one-time capture lease consumption, and AFTER-state recapture.'
        : 'Physical fallback lacks complete capture-bound postcondition evidence.', versions(physical));
    }

    const verify = lastSucceeded(records, `${prefix}verify-app-target`);
    const inspect = verify ?? lastSucceeded(records, `${prefix}inspect-app-target`);
    const state = observationState(inspect);
    const elements = Array.isArray(state.uiaElements) ? state.uiaElements.map(asRecord) : [];
    const selector = asRecord(verify ? (goal.verifySelector ?? goal.selector) : goal.selector);
    const element = elements.find((candidate) => uiaSelectorMatches(candidate, selector));
    const operation = String(goal.operation ?? '');
    if (!verify && operation !== 'set_value') {
      return outcome(true, false, 'Application operation requires a fresh post-operation semantic reinspection before outcome truth can be certified.', versions(inspect));
    }
    const operate = lastSucceeded(records, `${prefix}operate-app-target`);
    const operatePostcondition = asRecord(observationState(operate).postcondition);
    const providerVerified = operate ? operatePostcondition.verified === true : operation === 'set_value';
    let semanticEffect = Boolean(element);
    if (semanticEffect && operation === 'set_value') semanticEffect = element!.valueHash === sha256(String(goal.value ?? ''));
    if (semanticEffect && operation === 'focus' && element!.focused !== undefined) semanticEffect = element!.focused === true;
    if (semanticEffect && operation === 'select' && element!.selected !== undefined) semanticEffect = element!.selected === true;
    if (semanticEffect && operation === 'expand' && element!.expandCollapseState !== undefined) semanticEffect = element!.expandCollapseState === 'expanded';
    if (semanticEffect && operation === 'collapse' && element!.expandCollapseState !== undefined) semanticEffect = element!.expandCollapseState === 'collapsed';
    const alreadySatisfied = operation === 'set_value' && !verify && semanticEffect;
    const ok = Boolean(inspect && semanticEffect && (alreadySatisfied || (operate && providerVerified)));
    return outcome(true, ok, ok
      ? alreadySatisfied
        ? 'Initial semantic UIA observation proves the requested value already exists, so no environment mutation is required.'
        : 'Provider-verified UIA operation plus fresh semantic reinspection proves the typed application outcome.'
      : 'Application outcome is not proven by a unique matching semantic target and verified post-operation state.', mergeRecordVersions([inspect, operate]));
  }
  return outcome(false, false, `No typed outcome evaluator exists for goal kind ${kind || 'missing'}.`, []);
}

function evaluateQualityGate(records: TaskActionRecord[], state: Record<string, unknown>): TaskOutcomeTruth {
  const checks = Array.isArray(state.qualityChecks) ? state.qualityChecks.map(asRecord) : [];
  if (checks.length === 0) return outcome(true, false, 'Quality gate has no compiled trusted checks to verify.', []);
  const used: Array<TaskActionRecord | undefined> = [];
  const ok = checks.every((check, index) => {
    const kind = String(check.kind ?? '');
    const record = lastSucceeded(records, `quality-run:${index}:${kind}`);
    used.push(record);
    if (!record) return false;
    const machine = observationState(record);
    return machine.exitCode === 0 && machine.validationPassed !== false;
  });
  return outcome(true, ok, ok
    ? `All ${checks.length} compiled trusted quality checks have successful durable machine evidence.`
    : 'At least one compiled trusted quality check lacks successful durable machine evidence.', mergeRecordVersions(used));
}

function lastSucceeded(records: TaskActionRecord[], stepKey: string): TaskActionRecord | undefined {
  return [...records].reverse().find((record) => record.stepKey === stepKey && record.state === 'SUCCEEDED');
}

function lastSucceededAny(records: TaskActionRecord[], stepKeys: string[]): TaskActionRecord | undefined {
  const allowed = new Set(stepKeys);
  return [...records].reverse().find((record) => allowed.has(record.stepKey) && record.state === 'SUCCEEDED');
}

function observationState(record: TaskActionRecord | undefined): Record<string, unknown> {
  const observation = record?.observation;
  return observation?.schemaVersion === 2 ? observation.importantState : {};
}

function versions(record: TaskActionRecord | undefined): string[] {
  const observation = record?.observation;
  return observation?.schemaVersion === 2 ? [observation.stateVersion] : [];
}

function mergeRecordVersions(records: Array<TaskActionRecord | undefined>): string[] {
  return [...new Set(records.flatMap((record) => versions(record)))].sort();
}

function mergeVersions(items: TaskOutcomeTruth[]): string[] {
  return [...new Set(items.flatMap((item) => item.stateVersions))].sort();
}

function uiaSelectorMatches(element: Record<string, unknown>, selector: Record<string, unknown>): boolean {
  const mapping: Array<[string, string]> = [
    ['name', 'nameHash'],
    ['automationId', 'automationIdHash'],
    ['className', 'classNameHash'],
    ['controlType', 'controlTypeHash']
  ];
  for (const [source, observed] of mapping) {
    if (selector[source] !== undefined && element[observed] !== sha256(String(selector[source]))) return false;
  }
  if (selector.processId !== undefined && Number(element.processId) !== Number(selector.processId)) return false;
  return mapping.some(([source]) => selector[source] !== undefined) || selector.processId !== undefined;
}

function browserDestinationDigest(raw: string): string | undefined {
  try {
    const parsed = new URL(raw);
    parsed.hash = '';
    const pathname = parsed.pathname === '/' ? '/' : parsed.pathname.replace(/\/$/, '');
    return sha256(`${parsed.origin}${pathname}${parsed.search}`);
  } catch {
    return undefined;
  }
}

function outcome(supported: boolean, ok: boolean, detail: string, stateVersions: string[]): TaskOutcomeTruth {
  return { supported, ok, detail, stateVersions: [...new Set(stateVersions)].sort() };
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function builtinPlannerStateIsTerminal(task: TaskCapsule): boolean {
  const execution = task.execution;
  if (!execution) return false;
  const state = execution.plannerState;
  if (execution.plannerId === 'operator.semantic.v1') return state.phase === 'complete' || state.phase === 'physical-complete';
  if (execution.plannerId === 'operator.project-quality-gate.v1') return state.phase === 'complete';
  if (execution.plannerId === 'operator.semantic-workflow.v1') {
    const goal = state.goal;
    if (!goal || typeof goal !== 'object' || Array.isArray(goal)) return false;
    const steps = (goal as Record<string, unknown>).steps;
    const index = Number(state.workflowIndex ?? 0);
    return Array.isArray(steps) && Number.isSafeInteger(index) && index === steps.length;
  }
  if (execution.plannerId === 'operator.autonomous-workflow.v1') {
    const goal = state.goal;
    if (!goal || typeof goal !== 'object' || Array.isArray(goal)) return false;
    const steps = (goal as Record<string, unknown>).steps;
    const plan = state.durablePlan;
    if (plan && typeof plan === 'object' && !Array.isArray(plan)) {
      const subgoals = (plan as Record<string, unknown>).subgoals;
      return Array.isArray(steps) && Array.isArray(subgoals) && subgoals.length >= steps.length
        && subgoals.every((item) => item && typeof item === 'object' && ['VERIFIED', 'CANCELLED'].includes(String((item as Record<string, unknown>).status)))
        && state.autonomousPhase === 'observe' && state.activeSubgoalId === undefined;
    }
    const index = Number(state.workflowIndex ?? 0);
    return Array.isArray(steps) && Number.isSafeInteger(index) && index === steps.length && state.autonomousPhase === 'observe';
  }
  // Custom/test planners remain extensible; they are still constrained by graph,
  // action-record, observation and success-condition verification above.
  return true;
}
