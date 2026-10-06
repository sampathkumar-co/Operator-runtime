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

export function createDeveloperChangeQualificationPlan(input: {
  editPlan: MultiFileEditPlan;
  trustedCommandInspection: ActionResult;
}): DeveloperChangeQualificationPlan {
  const editPlan = validateMultiFileEditPlan(input.editPlan);
  const inspected = validateTrustedCommandInspection(input.trustedCommandInspection);
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
  if (!input || input.schemaVersion !== 1 || !/^[0-9a-f]{64}$/.test(String(input.id ?? ''))) {
    throw new OperatorError('DEVELOPER_QUALIFICATION_PLAN_INVALID', 'Qualification plan shape is invalid.');
  }
  if (!/^[0-9a-f]{64}$/.test(String(input.editPlanId ?? ''))) {
    throw new OperatorError('DEVELOPER_QUALIFICATION_PLAN_INVALID', 'editPlanId is invalid.');
  }
  if (!path.isAbsolute(input.projectRoot)) {
    throw new OperatorError('DEVELOPER_QUALIFICATION_PLAN_INVALID', 'projectRoot must be absolute.');
  }
  if (!Array.isArray(input.changedPaths) || input.changedPaths.length < 1) {
    throw new OperatorError('DEVELOPER_QUALIFICATION_PLAN_INVALID', 'changedPaths is invalid.');
  }
  if (!Array.isArray(input.requiredTestPaths) || !Array.isArray(input.steps) || input.steps.length < 1) {
    throw new OperatorError('DEVELOPER_QUALIFICATION_PLAN_INVALID', 'Qualification plan arrays are invalid.');
  }
  const steps = input.steps.map((step, index) => normalizeStep(step, index + 1));
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
    editPlanId: input.editPlanId,
    projectRoot: path.resolve(input.projectRoot),
    changedPaths: uniqueRelativePaths(input.changedPaths, 'changedPaths'),
    requiredTestPaths: uniqueRelativePaths(input.requiredTestPaths, 'requiredTestPaths'),
    steps,
    reindexAfterFormatting: input.reindexAfterFormatting === true
  };
  const id = crypto.createHash('sha256').update(canonicalJson(identity), 'utf8').digest('hex');
  if (id !== input.id) {
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
  if (
    !result ||
    result.ok !== true ||
    result.capability !== 'project.command.inspect' ||
    result.provider !== 'project.command.trusted' ||
    !result.evidence.some((item) => item.kind === 'command_registry' && item.status === 'pass')
  ) {
    throw new OperatorError(
      'DEVELOPER_QUALIFICATION_REGISTRY_UNTRUSTED',
      'Qualification planning requires a successful trusted project-command inspection result.'
    );
  }

  const output = result.output as {
    projectRoot?: unknown;
    registryConfigured?: unknown;
    commands?: unknown;
  } | undefined;
  const projectRoot = String(output?.projectRoot ?? '');
  if (!path.isAbsolute(projectRoot)) {
    throw new OperatorError('DEVELOPER_QUALIFICATION_REGISTRY_INVALID', 'Trusted command inspection projectRoot is invalid.');
  }
  if (output?.registryConfigured !== true || !Array.isArray(output.commands) || output.commands.length > MAX_COMMANDS) {
    throw new OperatorError('DEVELOPER_QUALIFICATION_REGISTRY_INVALID', 'Trusted command inspection registry payload is invalid.');
  }

  const seen = new Set<string>();
  const commands: TrustedCommandSummary[] = [];
  for (const item of output.commands) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new OperatorError('DEVELOPER_QUALIFICATION_REGISTRY_INVALID', 'Trusted command entry is invalid.');
    }
    const raw = item as Record<string, unknown>;
    const id = String(raw.id ?? '');
    if (!COMMAND_ID.test(id) || seen.has(id)) {
      throw new OperatorError('DEVELOPER_QUALIFICATION_REGISTRY_INVALID', 'Trusted command id is invalid or duplicated.');
    }
    seen.add(id);

    const kind = String(raw.kind ?? '');
    if (!KIND_ORDER.includes(kind as DeveloperQualificationKind)) {
      // dev/database/custom commands are intentionally ignored. They are
      // not implicit qualification authority.
      continue;
    }
    const risk = String(raw.risk ?? '');
    if (risk === 'external') {
      // R3 workstation qualification must remain local/hermetic. External
      // checks need an explicit higher-layer workflow and separate approval.
      continue;
    }
    if (risk !== 'read' && risk !== 'write') {
      throw new OperatorError(
        'DEVELOPER_QUALIFICATION_REGISTRY_INVALID',
        'Qualification command risk must be read or write.'
      );
    }
    commands.push({
      id,
      kind: kind as DeveloperQualificationKind,
      risk
    });
  }
  commands.sort((a, b) =>
    KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
    a.id.localeCompare(b.id)
  );
  return { projectRoot: path.resolve(projectRoot), commands };
}

function normalizeStep(input: DeveloperQualificationStep, expectedOrder: number): DeveloperQualificationStep {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new OperatorError('DEVELOPER_QUALIFICATION_PLAN_INVALID', 'Qualification step is invalid.');
  }
  if (input.order !== expectedOrder) {
    throw new OperatorError('DEVELOPER_QUALIFICATION_PLAN_INVALID', 'Qualification step order is not contiguous.');
  }
  if (!COMMAND_ID.test(String(input.commandId ?? ''))) {
    throw new OperatorError('DEVELOPER_QUALIFICATION_PLAN_INVALID', 'Qualification commandId is invalid.');
  }
  if (!KIND_ORDER.includes(input.kind)) {
    throw new OperatorError('DEVELOPER_QUALIFICATION_PLAN_INVALID', 'Qualification kind is invalid.');
  }
  if (input.risk !== 'read' && input.risk !== 'write') {
    throw new OperatorError('DEVELOPER_QUALIFICATION_PLAN_INVALID', 'Qualification risk is invalid.');
  }
  const reason = String(input.reason ?? '');
  if (!reason || Buffer.byteLength(reason, 'utf8') > 2048 || reason.includes('\0')) {
    throw new OperatorError('DEVELOPER_QUALIFICATION_PLAN_INVALID', 'Qualification reason is invalid.');
  }
  return {
    order: expectedOrder,
    commandId: input.commandId,
    kind: input.kind,
    risk: input.risk,
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
  if (!Array.isArray(input) || input.length > 10_000) {
    throw new OperatorError('DEVELOPER_QUALIFICATION_PLAN_INVALID', label + ' is invalid.');
  }
  const values = input.map((item) => {
    const value = String(item ?? '');
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
