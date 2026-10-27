import crypto from 'node:crypto';
import path from 'node:path';
import { canonicalJson } from './action-identity.ts';
import { evidence } from './evidence.ts';
import type { Evidence } from './types.ts';
import type { TaskActionRecord, TaskCapsule } from './task.ts';
import { VerificationKernel } from './verification-kernel.ts';
import { postgresSelectActionInput } from './semantic-task-input.ts';
import { assertTaskMachineState, normalizeTaskStateAssertions } from './task-state-assertion.ts';

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
  const semanticObservationPresent = execution?.records.some((record) =>
    record.state === 'SUCCEEDED' && record.observation !== undefined
  ) ?? false;
  // A failed/interrupted action or an INFO/FAIL diagnostic is not proof of
  // the requested outcome, even when it exists in the durable action journal.
  const successfulProviderEvidencePresent = execution?.records.some((record) =>
    record.state === 'SUCCEEDED' && record.evidence.some((item) => item.status === 'pass')
  ) ?? false;
  const epistemicallyUnresolved = execution?.records.filter((record) => record.state === 'SUCCEEDED'
    && record.observation?.schemaVersion === 2
    && record.observation.epistemicStatus !== 'KNOWN') ?? [];

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
    name: 'epistemic-state-resolved',
    ok: epistemicallyUnresolved.length === 0,
    detail: epistemicallyUnresolved.length === 0
      ? 'Every successful machine observation is explicitly KNOWN; ambiguity, contradiction, unavailability, and execution uncertainty cannot promote completion.'
      : `${epistemicallyUnresolved.length} successful action observation(s) remain epistemically unresolved.`
  });
  checks.push({
    name: 'evidence-present',
    ok: semanticObservationPresent || successfulProviderEvidencePresent,
    detail: semanticObservationPresent
      ? 'At least one durable semantic/visual machine observation supports completion.'
      : successfulProviderEvidencePresent
        ? 'At least one succeeded action has positive provider evidence.'
        : 'Completion requires a succeeded action with positive provider evidence or machine observation; failed/info-only events are not proof.'
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
    const verified = evaluateAtomicGoal(goal, execution.records, '');
    // An unrecognised built-in goal is not an extensible custom planner.
    // Otherwise successful provider evidence could bypass typed outcome truth.
    return verified.supported ? verified : outcome(true, false,
      `Semantic goal outcome is not independently verifiable: ${verified.detail}`,
      verified.stateVersions);
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
      const observed = record.observation;
      // A verification read cannot be replaced by the action's own success result,
      // a stale observation, or an epistemically uncertain snapshot.
      const startedAt = Date.parse(record.startedAt);
      const finishedAt = record.finishedAt ? Date.parse(record.finishedAt) : NaN;
      const observedAt = Date.parse(observed.observedAt);
      if (record.risk !== 'read' || observed.capability !== record.capability
        || observed.epistemicStatus !== 'KNOWN' || observed.ambiguous === true
        || !Number.isFinite(startedAt) || !Number.isFinite(finishedAt)
        || !Number.isFinite(observedAt) || finishedAt < startedAt
        || observedAt < startedAt || observedAt > finishedAt) {
        return outcome(true, false, `Autonomous step ${index + 1} lacks a fresh, known, read-only verification observation.`, mergeRecordVersions(records));
      }
      const verify = asRecord(steps[index]!.verify);
      // Checking an empty array was previously vacuously true and could promote
      // VERIFIED without proving even one requested postcondition.
      try {
        const assertions = normalizeTaskStateAssertions(verify.assertions, `autonomous step ${index + 1}.verify.assertions`);
        assertTaskMachineState(observed.importantState, assertions);
      } catch {
        return outcome(true, false, `Autonomous step ${index + 1} has missing/invalid or unsatisfied verification assertions.`, mergeRecordVersions(records));
      }
    }
    return outcome(true, true, `All ${steps.length} autonomous steps are independently proven by read-only durable machine observations.`, mergeRecordVersions(records));
  }
  return outcome(false, false, 'Planner does not use a built-in typed goal-outcome contract.', []);
}

function evaluateAtomicGoal(goal: Record<string, unknown>, records: TaskActionRecord[], prefix: string): TaskOutcomeTruth {
  const kind = typeof goal.kind === 'string' ? goal.kind : '';
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
    // A trusted git.status observation emits literal SHA-256 strings. Never
    // coerce a forged object/getter into a matching proof of Git visibility.
    const gitPathHashes = exactObservedDigestList(gitState.gitPathHashes);
    const ok = Boolean(fileRecord && gitRecord && expectedSha && expectedPathHash
      && fileState.sha256 === expectedSha && gitPathHashes.includes(expectedPathHash));
    return outcome(true, ok, ok
      ? 'Exact requested file bytes and Git visibility are independently proven by fresh durable machine observations.'
      : 'Completion lacks either the exact file-content digest or fresh Git visibility for the requested path.', mergeRecordVersions([fileRecord, gitRecord]));
  }
  if (kind === 'trusted-project-command') {
    const record = lastSucceeded(records, `${prefix}run-command`);
    const state = observationState(record);
    const expectedKind = typeof goal.commandKind === 'string' ? goal.commandKind : '';
    const observed = record?.observation;
    const start = Date.parse(record?.startedAt ?? '');
    const finish = Date.parse(record?.finishedAt ?? '');
    const seen = observed?.schemaVersion === 2 ? Date.parse(observed.observedAt) : NaN;
    const ok = Boolean(record && ['lint', 'test', 'build'].includes(expectedKind)
      && record.capability === 'project.command.run'
      && observed?.schemaVersion === 2 && observed.capability === record.capability
      && observed.epistemicStatus === 'KNOWN' && observed.ambiguous === false
      && Number.isFinite(start) && Number.isFinite(finish) && Number.isFinite(seen)
      && start <= seen && seen <= finish
      && state.commandKind === expectedKind && state.exitCode === 0 && state.validationPassed === true);
    return outcome(true, ok, ok
      ? 'Trusted command kind, zero exit status, and registered artifact validation are proven by durable execution evidence.'
      : 'Trusted command completion is missing a matching zero-exit validated machine observation.', versions(record));
  }
  if (kind === 'browser-navigation') {
    const record = lastSucceededAny(records, [`${prefix}verify-browser`, `${prefix}inspect-browser`]);
    const state = observationState(record);
    const expectedDigest = typeof goal.url === 'string' ? browserDestinationDigest(goal.url) : undefined;
    const expectedRouteDigest = typeof goal.url === 'string' ? browserRouteDigest(goal.url) : undefined;
    const expectedTargetId = typeof goal.targetId === 'string' ? goal.targetId : undefined;
    const targets = Array.isArray(state.browserTargets) ? state.browserTargets.map(asRecord) : [];
    const matched = targets.some((target) => target.destinationDigest === expectedDigest
      && (!expectedRouteDigest || target.routeDigest === expectedRouteDigest)
      && (!expectedTargetId || target.id === expectedTargetId)
      && (expectedTargetId || target.type === undefined || target.type === 'page'));
    const ok = Boolean(causalIndependentRead(record) && expectedDigest && matched);
    return outcome(true, ok, ok
      ? 'A fresh browser observation proves the requested logical destination without trusting planner completion text.'
      : 'No fresh browser observation proves the requested destination and target identity.', versions(record));
  }
  if (kind === 'browser-download') {
    const record = lastSucceeded(records, `${prefix}download-browser-artifact`);
    const observed = record?.observation;
    const state = observationState(record);
    const download = asRecord(state.download);
    const target = asRecord(goal.target);
    const targetKeys = Object.keys(target);
    const allowedTargetKeys = new Set(['ref', 'role', 'name', 'text', 'css']);
    const targetLimits: Record<string, number> = { ref: 128, role: 500, name: 500, text: 500, css: 500 };
    const targetValid = targetKeys.length > 0 && targetKeys.every((key) => allowedTargetKeys.has(key)
      && typeof target[key] === 'string' && (target[key] as string).length > 0
      && (target[key] as string) === (target[key] as string).trim()
      && (target[key] as string).length <= targetLimits[key]! && !(target[key] as string).includes('\0'));
    const targetId = typeof goal.targetId === 'string' && /^[A-Za-z0-9._:-]{1,256}$/.test(goal.targetId) ? goal.targetId : undefined;
    const expectedSha256 = typeof goal.expectedSha256 === 'string' && /^[0-9a-f]{64}$/.test(goal.expectedSha256)
      ? goal.expectedSha256 : undefined;
    const timeoutMs = goal.timeoutMs === undefined ? 30_000 : goal.timeoutMs;
    const timeoutValid = typeof timeoutMs === 'number' && Number.isSafeInteger(timeoutMs) && timeoutMs >= 1_000 && timeoutMs <= 600_000;
    const filenameValid = goal.expectedSuggestedFilename === undefined
      || (typeof goal.expectedSuggestedFilename === 'string' && goal.expectedSuggestedFilename.length > 0
        && goal.expectedSuggestedFilename.length <= 500 && !goal.expectedSuggestedFilename.includes('\0'));
    if (!record || !targetValid || !targetId || !expectedSha256 || !timeoutValid || !filenameValid) {
      return outcome(true, false, 'Browser download goal or its terminal action evidence is missing or malformed.', versions(record));
    }
    const origin = typeof goal.origin === 'string' ? goal.origin : '';
    let originValid = false;
    try {
      const parsedOrigin = new URL(origin);
      originValid = ['http:', 'https:'].includes(parsedOrigin.protocol) && parsedOrigin.origin === origin
        && !parsedOrigin.username && !parsedOrigin.password;
    } catch { /* Invalid origin is not proof. */ }
    const expectedInput = { targetId, operation: 'click', target, expectDownload: true,
      expectedOrigin: origin, downloadTimeoutMs: timeoutMs };
    const expectedTargetDigest = sha256(canonicalJson({ targetId, target }));
    const start = Date.parse(record.startedAt);
    const finish = Date.parse(record.finishedAt ?? '');
    const seen = observed?.schemaVersion === 2 ? Date.parse(observed.observedAt) : NaN;
    const completed = typeof download.completedAt === 'string' ? Date.parse(download.completedAt) : NaN;
    const expectedFilenameDigest = typeof goal.expectedSuggestedFilename === 'string' ? sha256(goal.expectedSuggestedFilename) : undefined;
    const artifactBytes = download.artifactBytes;
    const predicates = {
      capability: record.capability === 'browser.interact',
      inputHash: originValid && record.inputHash === sha256(canonicalJson(expectedInput)),
      observation: observed?.schemaVersion === 2 && observed.capability === record.capability
        && observed.epistemicStatus === 'KNOWN' && observed.ambiguous === false,
      freshness: Number.isFinite(start) && Number.isFinite(finish) && Number.isFinite(seen)
        && Number.isFinite(completed) && start <= completed && completed <= seen && seen <= finish,
      state: download.state === 'completed',
      artifactHash: download.artifactSha256 === expectedSha256,
      artifactBytes: typeof artifactBytes === 'number' && Number.isSafeInteger(artifactBytes)
        && artifactBytes >= 0 && artifactBytes <= 512 * 1024 * 1024,
      initiatingTarget: download.initiatingTargetId === targetId,
      actionTarget: download.actionTargetDigest === expectedTargetDigest,
      suggestedFilename: expectedFilenameDigest === undefined || download.suggestedFilenameDigest === expectedFilenameDigest
    };
    const ok = Object.values(predicates).every(Boolean);
    const failed = Object.entries(predicates).filter(([, pass]) => !pass).map(([name]) => name);
    return outcome(true, ok, ok
      ? 'Fresh downloaded bytes match the requested SHA-256 and are bound to the exact initiating browser action target.'
      : `Browser download evidence does not satisfy the exact typed outcome contract: ${failed.join(', ')}.`, versions(record));
  }
  if (kind === 'docker-lifecycle') {
    const record = lastSucceededAny(records, [`${prefix}verify-docker-project`, `${prefix}inspect-docker-project`]);
    const state = observationState(record);
    // A malformed action cannot be reinterpreted as 'start'. Likewise,
    // String(array/object) must not turn a forged service or state into a
    // genuine successful Docker lifecycle observation.
    const validOperation = goal.operation === 'start' || goal.operation === 'stop' || goal.operation === 'restart';
    const services = Array.isArray(goal.services) && goal.services.length > 0 &&
      goal.services.every((service) => typeof service === 'string' && service.length > 0)
      ? goal.services as string[] : [];
    const expectedState = goal.operation === 'stop' ? 'exited' : 'running';
    const observed = Array.isArray(state.services) ? state.services.map(asRecord) : [];
    const ok = Boolean(record && validOperation && state.scope === 'project' && services.length > 0 && services.every((service) => {
      const item = observed.find((candidate) => candidate.service === service);
      const states = Array.isArray(item?.states) && item.states.length > 0 &&
        item.states.every((value) => typeof value === 'string')
        ? item.states as string[] : [];
      return states.length > 0 && states.every((value) => value === expectedState);
    }));
    return outcome(true, ok, ok
      ? `Fresh project-scoped Docker inspection proves every requested service is ${expectedState}.`
      : `Fresh Docker inspection does not prove every requested service reached ${expectedState}.`, versions(record));
  }
  if (kind === 'postgres-select') {
    // A typed goal must remain typed through verification. Coercing arrays,
    // objects or numeric strings here can make malformed requests appear to
    // match a previously recorded SELECT, or execute attacker toString hooks.
    const stringFields = ['root', 'profileId', 'table'] as const;
    const optionalStrings = ['schema'] as const;
    const numericFields = ['limit', 'offset', 'timeoutMs'] as const;
    const valid = stringFields.every(key => typeof goal[key] === 'string' && (goal[key] as string).length > 0)
      && optionalStrings.every(key => goal[key] === undefined || (typeof goal[key] === 'string' && (goal[key] as string).length > 0))
      && numericFields.every(key => goal[key] === undefined || (typeof goal[key] === 'number' && Number.isSafeInteger(goal[key]) && (goal[key] as number) >= 0))
      && (goal.columns === undefined || (Array.isArray(goal.columns) && goal.columns.every(value => typeof value === 'string' && value.length > 0)))
      && (goal.filters === undefined || Array.isArray(goal.filters))
      && (goal.orderBy === undefined || Array.isArray(goal.orderBy));
    if (!valid) return outcome(true, false, 'PostgreSQL goal has malformed input types; no SELECT result can certify it.', []);
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
    // Machine-state normalization emits only literal numeric row counters
    // and bounded column-name strings. Do not turn forged objects, strings
    // or accessor properties into apparently valid database receipts.
    const actualColumns = exactObservedPostgresColumns(state.columns);
    const rowCount = state.rowCount;
    const limit = goal.limit ?? 100;
    const expectedInputHash = sha256(canonicalJson(expectedInput));
    const predicates = {
      record: Boolean(record),
      inputHash: record?.inputHash === expectedInputHash,
      profile: state.profileId === goal.profileId,
      schema: state.schema === (goal.schema ?? 'public'),
      table: state.table === goal.table,
      limit: typeof state.limit === 'number' && Number.isSafeInteger(state.limit) && state.limit === limit,
      offset: typeof state.offset === 'number' && Number.isSafeInteger(state.offset) &&
        state.offset === (goal.offset ?? 0),
      rowCount: typeof rowCount === 'number' && Number.isSafeInteger(rowCount) &&
        rowCount >= 0 && rowCount <= (limit as number),
      columns: actualColumns.length > 0 && canonicalJson(actualColumns) === canonicalJson(expectedColumns)
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
      // Do not resurrect an earlier completed visual fallback after a newer
      // semantic/physical mutation or verification attempt supersedes its proof.
      const laterGoalAttempt = records.slice(records.indexOf(physical) + 1).some((record) =>
        record.stepKey === `${prefix}operate-app-physical-fallback` ||
        record.stepKey === `${prefix}operate-app-target` ||
        record.stepKey === `${prefix}verify-app-target`);
      if (laterGoalAttempt) return outcome(true, false,
        'Physical fallback outcome was superseded by a later operation or verification attempt.', versions(physical));
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

    const latestMutation = [...records].reverse().find((record) =>
      record.stepKey === `${prefix}operate-app-target` ||
      record.stepKey === `${prefix}operate-app-physical-fallback`);
    const latestVerifyAttempt = [...records].reverse().find((record) => record.stepKey === `${prefix}verify-app-target`);
    const verify = lastSucceeded(records, `${prefix}verify-app-target`);
    // Initial inspection is valid only for a genuine no-op. Once mutation or
    // verification was attempted, a failed/latest attempt cannot fall back to
    // pre-action state and promote an unverified goal to success.
    const safeInitialOnly = !latestMutation && !latestVerifyAttempt;
    // A newer failed or unfinished initial read supersedes its previous
    // success even when no mutation was attempted. Never certify a no-op from
    // a stale inspection after a later contradictory/failed observation.
    const latestInitialAttempt = [...records].reverse().find(record =>
      record.stepKey === `${prefix}inspect-app-target`);
    const inspect = verify ?? (safeInitialOnly && latestInitialAttempt?.state === 'SUCCEEDED'
      ? latestInitialAttempt : undefined);
    const state = observationState(inspect);
    const elements = Array.isArray(state.uiaElements) ? state.uiaElements.map(asRecord) : [];
    const selector = asRecord(verify ? (goal.verifySelector ?? goal.selector) : goal.selector);
    const element = elements.find((candidate) => uiaSelectorMatches(candidate, selector));
    const operation = typeof goal.operation === 'string' ? goal.operation : '';
    // Only the declared string value can be compared with machine-state
    // hashes. Calling String() on an object would execute caller code.
    if (operation === '' || (operation === 'set_value' && typeof goal.value !== 'string')) {
      return outcome(true, false, 'Application goal operation or desired value has malformed types.', versions(inspect));
    }
    if (!verify && operation !== 'set_value') {
      return outcome(true, false, 'Application operation requires a fresh post-operation semantic reinspection before outcome truth can be certified.', versions(inspect));
    }
    const operate = lastSucceeded(records, `${prefix}operate-app-target`);
    const operatePostcondition = asRecord(observationState(operate).postcondition);
    const providerVerified = operatePostcondition.verified === true;
    const knownFreshRead = (record: TaskActionRecord | undefined): boolean => {
      const observed = record?.observation;
      if (!record || record.risk !== 'read' || observed?.schemaVersion !== 2 ||
        observed.capability !== record.capability || observed.epistemicStatus !== 'KNOWN' ||
        observed.ambiguous === true) return false;
      const start = Date.parse(record.startedAt);
      const end = Date.parse(record.finishedAt ?? '');
      const captured = Date.parse(observed.observedAt);
      return Number.isFinite(start) && Number.isFinite(end) && Number.isFinite(captured)
        && start <= captured && captured <= end;
    };
    const latestGoalAttempt = [...records].reverse().find((record) =>
      record.stepKey === `${prefix}operate-app-target` ||
      record.stepKey === `${prefix}operate-app-physical-fallback` ||
      record.stepKey === `${prefix}verify-app-target`);
    // A newer mutating action supersedes a previously valid observation even
    // if the later action failed or its effect became uncertain.
    const verifiedAfterOperation = Boolean(verify && operate && latestGoalAttempt === verify &&
      knownFreshRead(verify) && Number.isFinite(Date.parse(operate.finishedAt ?? '')) &&
      Date.parse(verify!.startedAt) >= Date.parse(operate!.finishedAt!));
    let semanticEffect = Boolean(element);
    if (semanticEffect && operation === 'set_value') semanticEffect = element!.valueHash === sha256(goal.value as string);
    if (semanticEffect && operation === 'focus' && element!.focused !== undefined) semanticEffect = element!.focused === true;
    if (semanticEffect && operation === 'select' && element!.selected !== undefined) semanticEffect = element!.selected === true;
    if (semanticEffect && operation === 'expand' && element!.expandCollapseState !== undefined) semanticEffect = element!.expandCollapseState === 'expanded';
    if (semanticEffect && operation === 'collapse' && element!.expandCollapseState !== undefined) semanticEffect = element!.expandCollapseState === 'collapsed';
    const alreadySatisfied = operation === 'set_value' && safeInitialOnly && knownFreshRead(inspect) && semanticEffect;
    const ok = Boolean(inspect && semanticEffect && (alreadySatisfied || (operate && providerVerified && verifiedAfterOperation)));
    return outcome(true, ok, ok
      ? alreadySatisfied
        ? 'Fresh initial UIA inspection proves the requested value already exists and no mutation or verification was attempted.'
        : 'Provider-verified UIA operation plus causally later independent semantic reinspection proves the typed application outcome.'
      : 'Application outcome is not proven by a fresh post-operation semantic inspection or a clean no-op.', mergeRecordVersions([inspect, operate]));
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
    if (!record || !['lint', 'test', 'build'].includes(kind)
      || !['read', 'write'].includes(String(check.risk ?? ''))) return false;
    const observation = record.observation;
    if (observation?.schemaVersion !== 2 || observation.epistemicStatus !== 'KNOWN'
      || observation.ambiguous || observation.capability !== record.capability) return false;
    const started = Date.parse(record.startedAt);
    const finished = Date.parse(record.finishedAt ?? '');
    const observed = Date.parse(observation.observedAt);
    if (!Number.isFinite(started) || !Number.isFinite(finished)
      || !Number.isFinite(observed) || started > observed || observed > finished) return false;
    const expectedCapability = check.risk === 'write' ? 'project.transaction.run' : 'project.command.run';
    const machine = observationState(record);
    // A zero exit code without the exact compiled kind, matching provider,
    // known fresh machine observation and explicit artifact-validation result
    // cannot independently prove a quality gate.
    return record.capability === expectedCapability && machine.commandKind === kind
      && machine.exitCode === 0 && machine.validationPassed === true;
  });
  return outcome(true, ok, ok
    ? `All ${checks.length} compiled trusted quality checks have successful durable machine evidence.`
    : 'At least one compiled trusted quality check lacks successful durable machine evidence.', mergeRecordVersions(used));
}

/** Browser goal truth must come from a completed, independent machine read.
 * A matching digest inside an unknown, ambiguous or future-dated record is
 * not proof of the observed browser destination. */
function causalIndependentRead(record: TaskActionRecord | undefined): boolean {
  const observed = record?.observation;
  if (!record || record.state !== 'SUCCEEDED' || record.risk !== 'read' ||
      observed?.schemaVersion !== 2 || observed.capability !== record.capability ||
      observed.epistemicStatus !== 'KNOWN' || observed.ambiguous !== false) return false;
  const started = Date.parse(record.startedAt);
  const finished = Date.parse(record.finishedAt ?? '');
  const captured = Date.parse(observed.observedAt);
  return Number.isFinite(started) && Number.isFinite(finished) &&
    Number.isFinite(captured) && started <= captured && captured <= finished;
}

// Only the terminal attempt for an identity can attest an outcome. Never
// resurrect an earlier successful receipt after a later failed, interrupted,
// blocked or uncertain attempt for the same verification step.
function independentlyObservedAfterAction(record: TaskActionRecord | undefined): record is TaskActionRecord {
  if (!record || record.state !== 'SUCCEEDED') return false;
  if (record.observation?.schemaVersion !== 2) return true;
  const start = Date.parse(record.startedAt);
  const observed = Date.parse(record.observation.observedAt);
  // Typed machine-state proof cannot predate the very observation action
  // whose receipt claims to provide it. Reject invalid source timestamps.
  return Number.isFinite(start) && Number.isFinite(observed) && observed >= start;
}

function lastSucceeded(records: TaskActionRecord[], stepKey: string): TaskActionRecord | undefined {
  const latest = [...records].reverse().find((record) => record.stepKey === stepKey);
  return independentlyObservedAfterAction(latest) ? latest : undefined;
}

function lastSucceededAny(records: TaskActionRecord[], stepKeys: string[]): TaskActionRecord | undefined {
  const allowed = new Set(stepKeys);
  const latest = [...records].reverse().find((record) => allowed.has(record.stepKey));
  return independentlyObservedAfterAction(latest) ? latest : undefined;
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
  // Proof selectors are data, not executable descriptions. A coercible,
  // accessor-backed or unsupported selector must not match a UIA target.
  if (Object.getPrototypeOf(selector) !== Object.prototype &&
      Object.getPrototypeOf(selector) !== null) return false;
  const allowed = new Set([...mapping.map(([key]) => key), 'processId']);
  const keys = Reflect.ownKeys(selector);
  if (!keys.length || keys.some(key => typeof key !== 'string' || !allowed.has(key))) return false;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(selector, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return false;
    if (key === 'processId') {
      if (typeof descriptor.value !== 'number' ||
          !Number.isSafeInteger(descriptor.value) || descriptor.value <= 0 ||
          typeof element.processId !== 'number' || element.processId !== descriptor.value) return false;
    } else {
      if (typeof descriptor.value !== 'string' || descriptor.value.length === 0 ||
          descriptor.value.length > 512 || descriptor.value.includes('\\0')) return false;
      const targetHash = element[mapping.find(([source]) => source === key)![1]];
      if (targetHash !== sha256(descriptor.value)) return false;
    }
  }
  return true;
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

/** Snapshot only the exact inert digest list that git.status can emit. */
function exactObservedPostgresColumns(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50 ||
      Object.getPrototypeOf(value) !== Array.prototype ||
      Reflect.ownKeys(value).length !== value.length + 1) return [];
  const columns: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor) ||
        typeof descriptor.value !== 'string' ||
        !(descriptor.value === '*' || /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/.test(descriptor.value))) return [];
    columns.push(descriptor.value);
  }
  return columns;
}

function exactObservedDigestList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 500 ||
      Object.getPrototypeOf(value) !== Array.prototype ||
      Reflect.ownKeys(value).length !== value.length + 1) return [];
  const result: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor) ||
        typeof descriptor.value !== 'string' || !/^[0-9a-f]{64}$/.test(descriptor.value)) return [];
    result.push(descriptor.value);
  }
  return result;
}

/** An explicit hash-route is part of the SPA destination, but raw paths,
 * queries and fragments must not appear in durable machine observations. */
function browserRouteDigest(raw: string): string | undefined {
  try {
    const parsed = new URL(raw);
    if (!parsed.hash) return undefined;
    const pathname = parsed.pathname === '/' ? '/' : parsed.pathname.replace(/\/$/, '');
    return sha256(`${parsed.origin}${pathname}${parsed.search}${parsed.hash}`);
  } catch { return undefined; }
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
