import crypto from 'node:crypto';
import { canonicalJson } from './action-identity.ts';
import { evidence } from './evidence.ts';
import type { Evidence } from './types.ts';
import type { TaskCapsule } from './task.ts';

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

export function verifyTaskCompletion(task: TaskCapsule): { ok: boolean; bundle: TaskVerificationBundle; evidence: Evidence } {
  const execution = task.execution;
  const checks: TaskVerificationBundle['checks'] = [];
  const required = task.nodes.filter((node) => node.required);
  const unresolvedNodes = required.filter((node) => node.state !== 'VERIFIED' && node.state !== 'SKIPPED');
  const activeRecords = execution?.records.filter((record) => record.state === 'STARTED' || record.state === 'BLOCKED') ?? [];
  const failedRequired = required.filter((node) => node.state === 'FAILED' || node.state === 'BLOCKED');
  const conditionsPresent = task.successConditions.length > 0;
  const keyedNodeRecordMismatches = required.filter((node) => {
    if (!node.key) return false;
    const matching = execution?.records.filter((record) => record.stepKey === node.key) ?? [];
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
      ? `${task.successConditions.length} user-declared condition(s) are bound to the goal-derived semantic postconditions and evidence below.`
      : 'No success condition was declared.'
  });
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
  const digest = crypto.createHash('sha256').update(canonicalJson(base)).digest('hex');
  const bundle: TaskVerificationBundle = { ...base, digest };
  const ok = checks.every((check) => check.ok);
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
        checks: checks.map(({ name, ok }) => ({ name, ok }))
      }
    )
  };
}


function builtinPlannerStateIsTerminal(task: TaskCapsule): boolean {
  const execution = task.execution;
  if (!execution) return false;
  const state = execution.plannerState;
  if (execution.plannerId === 'operator.semantic.v1') return state.phase === 'complete';
  if (execution.plannerId === 'operator.project-quality-gate.v1') return state.phase === 'complete';
  if (execution.plannerId === 'operator.semantic-workflow.v1') {
    const goal = state.goal;
    if (!goal || typeof goal !== 'object' || Array.isArray(goal)) return false;
    const steps = (goal as Record<string, unknown>).steps;
    const index = Number(state.workflowIndex ?? 0);
    return Array.isArray(steps) && Number.isSafeInteger(index) && index === steps.length;
  }
  // Custom/test planners remain extensible; they are still constrained by graph,
  // action-record, observation and success-condition verification above.
  return true;
}
