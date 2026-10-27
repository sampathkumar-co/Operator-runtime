import crypto from 'node:crypto';
import path from 'node:path';
import { canonicalJson } from './action-identity.ts';
import { OperatorError } from './errors.ts';
import {
  validateMultiFileEditPlan,
  type MultiFileEditPlan
} from './multi-file-edit-plan.ts';
import type { ActionResult, ActionRisk } from './types.ts';

export type DeveloperQualificationKind = 'format' | 'lint' | 'test' | 'build';

export interface DeveloperQualificationStep {
  order: number;
  commandId: string;
  kind: DeveloperQualificationKind;
  risk: Extract<ActionRisk, 'read' | 'write'>;
  reason: string;
}

export interface DeveloperChangeQualificationPlan {
  schemaVersion: 1;
  id: string;
  editPlanId: string;
  projectRoot: string;
  changedPaths: string[];
  requiredTestPaths: string[];
  steps: DeveloperQualificationStep[];
  reindexAfterFormatting: boolean;
}

type TrustedCommandSummary = {
  id: string;
  kind: DeveloperQualificationKind;
  risk: Extract<ActionRisk, 'read' | 'write'>;
};

const COMMAND_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_COMMANDS = 100;
const KIND_ORDER: DeveloperQualificationKind[] = ['format', 'lint', 'test', 'build'];

/** Snapshot runtime/SDK records without invoking own accessors or coercion hooks. */
function inertRecord(input: unknown, code: string, label: string): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      (Object.getPrototypeOf(input) !== Object.prototype &&
       Object.getPrototypeOf(input) !== null)) {
    throw new OperatorError(code, label + ' must be a plain inert data object.');
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const copied: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string') throw new OperatorError(code, label + ' contains symbolic fields.');
    const field = descriptors[key]!;
    if (!field.enumerable || !('value' in field)) {
      throw new OperatorError(code, label + ' contains executable or hidden fields.');
    }
    copied[key] = field.value;
  }
  return copied;
}
function exactKeys(record: Record<string, unknown>, keys: readonly string[], code: string, label: string): void {
  if (Object.keys(record).length !== keys.length || keys.some(key => !Object.hasOwn(record, key))) {
    throw new OperatorError(code, label + ' contains missing or extra authority fields.');
  }
}
function inertArray(input: unknown, max: number, code: string, label: string): unknown[] {
  if (!Array.isArray(input) || input.length > max) {
    throw new OperatorError(code, label + ' must be a bounded array.');
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const keys = Reflect.ownKeys(input);
  if (keys.length !== input.length + 1 ||
      keys.some(key => typeof key !== 'string' ||
        (key !== 'length' && (!/^(0|[1-9][0-9]*)$/.test(key) ||
          !descriptors[key]?.enumerable || !('value' in descriptors[key]!))))) {
    throw new OperatorError(code, label + ' has executable, sparse or hidden array entries.');
  }
  return Array.from({ length: input.length }, (_, i) => descriptors[String(i)]!.value);
}

export function createDeveloperChangeQualificationPlan(input: {
  editPlan: MultiFileEditPlan;
  trustedCommandInspection: ActionResult;
}): DeveloperChangeQualificationPlan {
  const request = inertRecord(input, 'DEVELOPER_QUALIFICATION_PLAN_INVALID', 'qualification request');
  exactKeys(request, ['editPlan', 'trustedCommandInspection'],
    'DEVELOPER_QUALIFICATION_PLAN_INVALID', 'qualification request');
  const editPlan = validateMultiFileEditPlan(request.editPlan as MultiFileEditPlan);
  const inspected = validateTrustedCommandInspection(request.trustedCommandInspection as ActionResult);
  const explicit = new Set(editPlan.verification.trustedCommandIds);

  const selected = explicit.size > 0
    ? inspected.commands.filter((command) => explicit.has(command.id))
    : inspected.commands;

  if (explicit.size > 0) {
    const missing = [...explicit].filter((id) => !inspected.commands.some((command) => command.id === id));
    if (missing.length > 0) {
      throw new OperatorError(
        'DEVELOPER_QUALIFICATION_COMMAND_MISSING',
        'Edit plan references trusted commands absent from the current registry inspection.',
        { details: { missing: missing.sort() } }
      );
    }
  }

  const qualification = selected.filter((command) => KIND_ORDER.includes(command.kind));
  if (qualification.length < 1) {
    throw new OperatorError(
      'DEVELOPER_QUALIFICATION_COMMANDS_UNAVAILABLE',
      'No local trusted format/lint/test/build commands are available for this edit plan.'
    );
  }

  const byKind = new Map<DeveloperQualificationKind, TrustedCommandSummary[]>();
  for (const kind of KIND_ORDER) byKind.set(kind, []);
  for (const command of qualification) byKind.get(command.kind)!.push(command);
  for (const values of byKind.values()) values.sort((a, b) => a.id.localeCompare(b.id));

  // A source edit should never be certified without at least one verification
  // command. Formatter-only plans are allowed to prepare bytes but not to stand
  // in for tests/lint/build evidence.
  const verifierCount =
    byKind.get('lint')!.length +
    byKind.get('test')!.length +
    byKind.get('build')!.length;
  if (verifierCount < 1) {
    throw new OperatorError(
      'DEVELOPER_QUALIFICATION_VERIFIER_REQUIRED',
      'At least one trusted lint, test, or build command is required.'
    );
  }

  if (editPlan.verification.requiredTestPaths.length > 0 && byKind.get('test')!.length < 1) {
    throw new OperatorError(
      'DEVELOPER_QUALIFICATION_TEST_COMMAND_REQUIRED',
      'Affected test paths were identified but no trusted test command is selected.'
    );
  }

  const steps: DeveloperQualificationStep[] = [];
  for (const kind of KIND_ORDER) {
    for (const command of byKind.get(kind)!) {
      steps.push({
        order: steps.length + 1,
        commandId: command.id,
        kind,
        risk: command.risk,
        reason: qualificationReason(kind, editPlan)
      });
    }
  }

  const changedPaths = editPlan.files.map((file) => file.path).sort();
  const requiredTestPaths = [...editPlan.verification.requiredTestPaths].sort();
  const reindexAfterFormatting = steps.some((step) => step.kind === 'format' && step.risk === 'write');
  const identity = {
    schemaVersion: 1 as const,
    editPlanId: editPlan.id,
    projectRoot: inspected.projectRoot,
    changedPaths,
    requiredTestPaths,
    steps,
    reindexAfterFormatting
  };

  return {
    ...identity,
    id: crypto.createHash('sha256').update(canonicalJson(identity), 'utf8').digest('hex')
  };
}

export function validateDeveloperChangeQualificationPlan(
  input: DeveloperChangeQualificationPlan
): DeveloperChangeQualificationPlan {
  const plan = inertRecord(input, 'DEVELOPER_QUALIFICATION_PLAN_INVALID', 'qualification plan') as unknown as DeveloperChangeQualificationPlan;
  exactKeys(plan as unknown as Record<string, unknown>,
    ['schemaVersion', 'id', 'editPlanId', 'projectRoot', 'changedPaths',
      'requiredTestPaths', 'steps', 'reindexAfterFormatting'],
    'DEVELOPER_QUALIFICATION_PLAN_INVALID', 'qualification plan');
  if (plan.schemaVersion !== 1 || typeof plan.id !== 'string' || !/^[0-9a-f]{64}$/.test(plan.id)) {
    throw new OperatorError('DEVELOPER_QUALIFICATION_PLAN_INVALID', 'Qualification plan shape is invalid.');
  }
  if ((typeof plan.editPlanId !== 'string' || !/^[0-9a-f]{64}$/.test(plan.editPlanId))) {
    throw new OperatorError('DEVELOPER_QUALIFICATION_PLAN_INVALID', 'editPlanId is invalid.');
  }
  if (typeof plan.projectRoot !== 'string' || !path.isAbsolute(plan.projectRoot)) {
    throw new OperatorError('DEVELOPER_QUALIFICATION_PLAN_INVALID', 'projectRoot must be absolute.');
  }
  if (!Array.isArray(plan.changedPaths) || plan.changedPaths.length < 1) {
    throw new OperatorError('DEVELOPER_QUALIFICATION_PLAN_INVALID', 'changedPaths is invalid.');
  }
  if (!Array.isArray(plan.requiredTestPaths) || !Array.isArray(plan.steps) || plan.steps.length < 1) {
    throw new OperatorError('DEVELOPER_QUALIFICATION_PLAN_INVALID', 'Qualification plan arrays are invalid.');
  }
  const steps = inertArray(plan.steps, MAX_COMMANDS, 'DEVELOPER_QUALIFICATION_PLAN_INVALID', 'steps')
    .map((step, index) => normalizeStep(step as DeveloperQualificationStep, index + 1));
  const seenCommands = new Set<string>();
  let previousKind = -1;
  for (const step of steps) {
    if (seenCommands.has(step.commandId)) {
      throw new OperatorError(
        'DEVELOPER_QUALIFICATION_PLAN_INVALID',
        'Qualification command ids must be unique.'
      );
    }
    seenCommands.add(step.commandId);
    const currentKind = KIND_ORDER.indexOf(step.kind);
    if (currentKind < previousKind) {
      throw new OperatorError(
        'DEVELOPER_QUALIFICATION_PLAN_INVALID',
        'Qualification steps must preserve format, lint, test, build phase order.'
      );
    }
    previousKind = currentKind;
  }
  const identity = {
    schemaVersion: 1 as const,
    editPlanId: plan.editPlanId,
    projectRoot: path.resolve(plan.projectRoot),
    changedPaths: uniqueRelativePaths(plan.changedPaths, 'changedPaths'),
    requiredTestPaths: uniqueRelativePaths(plan.requiredTestPaths, 'requiredTestPaths'),
    steps,
    reindexAfterFormatting: plan.reindexAfterFormatting === true
  };
  // An attacker can recompute a SHA-256 over a forged plan. The digest is
  // integrity addressing, not proof of a valid qualification lifecycle.
  if (!steps.some(step => step.kind === 'lint' || step.kind === 'test' || step.kind === 'build') ||
      (identity.requiredTestPaths.length > 0 && !steps.some(step => step.kind === 'test')) ||
      identity.reindexAfterFormatting !== steps.some(step => step.kind === 'format' && step.risk === 'write')) {
    throw new OperatorError('DEVELOPER_QUALIFICATION_PLAN_INVALID',
      'Qualification plan lacks required verification or has inconsistent formatter/reindex contract.');
  }
  const id = crypto.createHash('sha256').update(canonicalJson(identity), 'utf8').digest('hex');
  if (id !== plan.id) {
    throw new OperatorError(
      'DEVELOPER_QUALIFICATION_PLAN_INVALID',
      'Qualification plan id does not match immutable content.'
    );
  }
  return { ...identity, id };
}

function validateTrustedCommandInspection(result: ActionResult): {
  projectRoot: string;
  commands: TrustedCommandSummary[];
} {
  const receipt = inertRecord(result, 'DEVELOPER_QUALIFICATION_REGISTRY_UNTRUSTED', 'command receipt');
  const evidence = inertArray(receipt.evidence, 10_000,
    'DEVELOPER_QUALIFICATION_REGISTRY_UNTRUSTED', 'command evidence');
  const proof = evidence.some(item => {
    const event = inertRecord(item, 'DEVELOPER_QUALIFICATION_REGISTRY_UNTRUSTED', 'command evidence entry');
    return event.kind === 'command_registry' && event.status === 'pass';
  });
  if (receipt.ok !== true || receipt.capability !== 'project.command.inspect' ||
      receipt.provider !== 'project.command.trusted' || !proof) {
    throw new OperatorError('DEVELOPER_QUALIFICATION_REGISTRY_UNTRUSTED',
      'Qualification planning requires a successful trusted project-command inspection result.');
  }
  const output = inertRecord(receipt.output, 'DEVELOPER_QUALIFICATION_REGISTRY_INVALID', 'command registry');
  if (typeof output.projectRoot !== 'string' || !path.isAbsolute(output.projectRoot)) {
    throw new OperatorError('DEVELOPER_QUALIFICATION_REGISTRY_INVALID',
      'Trusted command inspection projectRoot is invalid.');
  }
  if (output.registryConfigured !== true) {
    throw new OperatorError('DEVELOPER_QUALIFICATION_REGISTRY_INVALID',
      'Trusted command registry was not configured.');
  }
  const entries = inertArray(output.commands, MAX_COMMANDS,
    'DEVELOPER_QUALIFICATION_REGISTRY_INVALID', 'registered commands');
  const seen = new Set<string>();
  const commands: TrustedCommandSummary[] = [];
  for (const entry of entries) {
    const raw = inertRecord(entry, 'DEVELOPER_QUALIFICATION_REGISTRY_INVALID', 'trusted command');
    const id = raw.id;
    if (typeof id !== 'string' || !COMMAND_ID.test(id) || seen.has(id)) {
      throw new OperatorError('DEVELOPER_QUALIFICATION_REGISTRY_INVALID',
        'Trusted command id is invalid or duplicated.');
    }
    seen.add(id);
    const kind = raw.kind;
    if (typeof kind !== 'string') {
      throw new OperatorError('DEVELOPER_QUALIFICATION_REGISTRY_INVALID',
        'Trusted command kind must be literal text.');
    }
    if (!KIND_ORDER.includes(kind as DeveloperQualificationKind)) {
      // Developer servers, database tasks and custom commands never become
      // implied post-edit verification authority.
      continue;
    }
    const risk = raw.risk;
    if (risk === 'external') continue;
    if (risk !== 'read' && risk !== 'write') {
      throw new OperatorError('DEVELOPER_QUALIFICATION_REGISTRY_INVALID',
        'Qualification command risk must be read or write.');
    }
    commands.push({ id, kind: kind as DeveloperQualificationKind, risk });
  }
  commands.sort((a, b) =>
    KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
    a.id.localeCompare(b.id)
  );
  return { projectRoot: path.resolve(output.projectRoot), commands };
}

function normalizeStep(input: DeveloperQualificationStep, expectedOrder: number): DeveloperQualificationStep {
  const step = inertRecord(input, 'DEVELOPER_QUALIFICATION_PLAN_INVALID', 'qualification step') as unknown as DeveloperQualificationStep;
  exactKeys(step as unknown as Record<string, unknown>,
    ['order', 'commandId', 'kind', 'risk', 'reason'],
    'DEVELOPER_QUALIFICATION_PLAN_INVALID', 'qualification step');
  if (step.order !== expectedOrder) {
    throw new OperatorError('DEVELOPER_QUALIFICATION_PLAN_INVALID', 'Qualification step order is not contiguous.');
  }
  if (typeof step.commandId !== 'string' || !COMMAND_ID.test(step.commandId)) {
    throw new OperatorError('DEVELOPER_QUALIFICATION_PLAN_INVALID', 'Qualification commandId is invalid.');
  }
  if (!KIND_ORDER.includes(step.kind)) {
    throw new OperatorError('DEVELOPER_QUALIFICATION_PLAN_INVALID', 'Qualification kind is invalid.');
  }
  if (step.risk !== 'read' && step.risk !== 'write') {
    throw new OperatorError('DEVELOPER_QUALIFICATION_PLAN_INVALID', 'Qualification risk is invalid.');
  }
  const reason = step.reason;
  if (typeof reason !== 'string' || !reason || Buffer.byteLength(reason, 'utf8') > 2048 || reason.includes('\0')) {
    throw new OperatorError('DEVELOPER_QUALIFICATION_PLAN_INVALID', 'Qualification reason is invalid.');
  }
  return {
    order: expectedOrder,
    commandId: step.commandId,
    kind: step.kind,
    risk: step.risk,
    reason
  };
}

function qualificationReason(
  kind: DeveloperQualificationKind,
  editPlan: MultiFileEditPlan
): string {
  if (kind === 'format') {
    return 'Normalize edited source bytes through a trusted formatter before verification.';
  }
  if (kind === 'lint') {
    return 'Check static project invariants after the multi-file edit.';
  }
  if (kind === 'test') {
    const count = editPlan.verification.requiredTestPaths.length;
    return count > 0
      ? 'Run trusted tests because impact analysis identified ' + String(count) + ' affected test path(s).'
      : 'Run trusted project tests for the edited source set.';
  }
  return 'Build the project through a trusted registry command as a final compile/package check.';
}

function uniqueRelativePaths(input: unknown, label: string): string[] {
  const values = inertArray(input, 10_000, 'DEVELOPER_QUALIFICATION_PLAN_INVALID', label).map((item) => {
    if (typeof item !== 'string') {
      throw new OperatorError('DEVELOPER_QUALIFICATION_PLAN_INVALID', label + ' requires literal string paths.');
    }
    const value = item;
    if (!value || value.includes('\0') || value.includes('\\')) {
      throw new OperatorError('DEVELOPER_QUALIFICATION_PLAN_INVALID', label + ' contains an invalid path.');
    }
    const normalized = path.posix.normalize(value);
    if (
      normalized === '.' ||
      normalized === '..' ||
      normalized.startsWith('../') ||
      path.posix.isAbsolute(normalized)
    ) {
      throw new OperatorError('DEVELOPER_QUALIFICATION_PLAN_INVALID', label + ' must contain workspace-relative paths.');
    }
    return normalized;
  });
  return [...new Set(values)].sort();
}
