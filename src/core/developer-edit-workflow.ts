import crypto from 'node:crypto';
import path from 'node:path';
import { canonicalJson } from './action-identity.ts';
import { OperatorError } from './errors.ts';
import {
  validateMultiFileEditPlan,
  type MultiFileEditPlan
} from './multi-file-edit-plan.ts';

export type DeveloperPostEditRole = 'format' | 'organize-imports';

export interface DeveloperPostEditCommand {
  commandId: string;
  roles: DeveloperPostEditRole[];
}

export interface DeveloperEditWorkflow {
  schemaVersion: 1;
  id: string;
  editPlanId: string;
  postEditCommands: DeveloperPostEditCommand[];
  verificationCommandIds: string[];
  requiredTestPaths: string[];
}

export type DeveloperEditWorkflowStep =
  | {
      ordinal: number;
      phase: 'apply';
      capability: 'workspace.edit.transaction';
      planId: string;
    }
  | {
      ordinal: number;
      phase: 'post-edit';
      capability: 'project.command.run';
      commandId: string;
      roles: DeveloperPostEditRole[];
    }
  | {
      ordinal: number;
      phase: 'verify';
      capability: 'project.command.run';
      commandId: string;
    };

const COMMAND_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+-=]{0,255}$/;
const MAX_COMMANDS = 256;
const MAX_TEST_PATHS = 5000;

export function createDeveloperEditWorkflow(input: {
  editPlan: MultiFileEditPlan;
  postEditCommands?: DeveloperPostEditCommand[];
  verificationCommandIds?: string[];
  requiredTestPaths?: string[];
}): DeveloperEditWorkflow {
  const plan = validateMultiFileEditPlan(input.editPlan);
  const postEditCommands = normalizePostEditCommands(input.postEditCommands ?? []);
  const verificationCommandIds = uniqueCommandIds([
    ...plan.verification.trustedCommandIds,
    ...(input.verificationCommandIds ?? [])
  ]);
  const requiredTestPaths = uniquePaths([
    ...plan.verification.requiredTestPaths,
    ...(input.requiredTestPaths ?? [])
  ]);

  const identity = {
    schemaVersion: 1 as const,
    editPlanId: plan.id,
    postEditCommands,
    verificationCommandIds,
    requiredTestPaths
  };
  return {
    ...identity,
    id: crypto.createHash('sha256').update(canonicalJson(identity), 'utf8').digest('hex')
  };
}

export function validateDeveloperEditWorkflow(
  input: DeveloperEditWorkflow
): DeveloperEditWorkflow {
  if (!input || input.schemaVersion !== 1 || typeof input.id !== 'string') {
    throw invalid('Developer edit workflow shape is invalid.');
  }
  const editPlanId = digest(input.editPlanId, 'editPlanId');
  const postEditCommands = normalizePostEditCommands(input.postEditCommands);
  const verificationCommandIds = uniqueCommandIds(input.verificationCommandIds);
  const requiredTestPaths = uniquePaths(input.requiredTestPaths);
  const identity = {
    schemaVersion: 1 as const,
    editPlanId,
    postEditCommands,
    verificationCommandIds,
    requiredTestPaths
  };
  const id = crypto.createHash('sha256').update(canonicalJson(identity), 'utf8').digest('hex');
  if (id !== input.id) throw invalid('Developer edit workflow id does not match immutable content.');
  return { ...identity, id };
}

export function developerEditWorkflowSteps(
  input: DeveloperEditWorkflow
): DeveloperEditWorkflowStep[] {
  const workflow = validateDeveloperEditWorkflow(input);
  const steps: DeveloperEditWorkflowStep[] = [];
  let ordinal = 1;
  steps.push({
    ordinal: ordinal++,
    phase: 'apply',
    capability: 'workspace.edit.transaction',
    planId: workflow.editPlanId
  });
  for (const command of workflow.postEditCommands) {
    steps.push({
      ordinal: ordinal++,
      phase: 'post-edit',
      capability: 'project.command.run',
      commandId: command.commandId,
      roles: [...command.roles]
    });
  }
  for (const commandId of workflow.verificationCommandIds) {
    steps.push({
      ordinal: ordinal++,
      phase: 'verify',
      capability: 'project.command.run',
      commandId
    });
  }
  return steps;
}

export function assertDeveloperEditWorkflowCoverage(
  workflowInput: DeveloperEditWorkflow,
  input: {
    appliedPlanId?: string;
    successfulPostEditCommandIds?: string[];
    successfulVerificationCommandIds?: string[];
    observedTestPaths?: string[];
  }
): void {
  const workflow = validateDeveloperEditWorkflow(workflowInput);
  if (input.appliedPlanId !== workflow.editPlanId) {
    throw new OperatorError(
      'DEVELOPER_EDIT_WORKFLOW_APPLY_MISSING',
      'Developer edit workflow has not proven application of its exact edit plan.'
    );
  }

  const post = new Set(uniqueCommandIds(input.successfulPostEditCommandIds ?? []));
  const missingPost = workflow.postEditCommands
    .map((item) => item.commandId)
    .filter((commandId) => !post.has(commandId));
  if (missingPost.length > 0) {
    throw new OperatorError(
      'DEVELOPER_EDIT_WORKFLOW_POST_EDIT_INCOMPLETE',
      'Formatter/import-organization commands are incomplete.',
      { details: { missingCommandIds: missingPost } }
    );
  }

  const verified = new Set(uniqueCommandIds(input.successfulVerificationCommandIds ?? []));
  const missingVerification = workflow.verificationCommandIds
    .filter((commandId) => !verified.has(commandId));
  if (missingVerification.length > 0) {
    throw new OperatorError(
      'DEVELOPER_EDIT_WORKFLOW_VERIFICATION_INCOMPLETE',
      'Developer edit workflow verification commands are incomplete.',
      { details: { missingCommandIds: missingVerification } }
    );
  }

  const observed = new Set(uniquePaths(input.observedTestPaths ?? []));
  const missingTests = workflow.requiredTestPaths.filter((testPath) => !observed.has(testPath));
  if (missingTests.length > 0) {
    throw new OperatorError(
      'DEVELOPER_EDIT_WORKFLOW_TEST_COVERAGE_INCOMPLETE',
      'Required affected tests were not observed in verification evidence.',
      { details: { missingTestPaths: missingTests } }
    );
  }
}

function normalizePostEditCommands(input: unknown): DeveloperPostEditCommand[] {
  if (!Array.isArray(input) || input.length > MAX_COMMANDS) {
    throw invalid('postEditCommands is invalid.');
  }
  const byId = new Map<string, Set<DeveloperPostEditRole>>();
  for (const raw of input) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw invalid('postEditCommands contains an invalid entry.');
    }
    const value = raw as Record<string, unknown>;
    const commandId = commandIdValue(value.commandId);
    if (!Array.isArray(value.roles) || value.roles.length < 1 || value.roles.length > 2) {
      throw invalid('postEdit command roles are invalid.');
    }
    const roles = value.roles.map((role) => {
      if (role !== 'format' && role !== 'organize-imports') {
        throw invalid('postEdit command role is invalid.');
      }
      return role as DeveloperPostEditRole;
    });
    const bucket = byId.get(commandId) ?? new Set<DeveloperPostEditRole>();
    for (const role of roles) bucket.add(role);
    byId.set(commandId, bucket);
  }
  return [...byId.entries()]
    .map(([commandId, roles]) => ({
      commandId,
      roles: [...roles].sort() as DeveloperPostEditRole[]
    }))
    .sort((a, b) => a.commandId.localeCompare(b.commandId));
}

function uniqueCommandIds(input: unknown): string[] {
  if (!Array.isArray(input) || input.length > MAX_COMMANDS) throw invalid('Command id list is invalid.');
  return [...new Set(input.map(commandIdValue))].sort();
}

function commandIdValue(input: unknown): string {
  const value = String(input ?? '');
  if (!COMMAND_ID.test(value)) throw invalid('Trusted command id is invalid.');
  return value;
}

function uniquePaths(input: unknown): string[] {
  if (!Array.isArray(input) || input.length > MAX_TEST_PATHS) throw invalid('requiredTestPaths is invalid.');
  return [...new Set(input.map(normalizeRelativePath))].sort();
}

function normalizeRelativePath(input: unknown): string {
  if (typeof input !== 'string' || !input || input.includes('\0') || input.includes('\\')) {
    throw invalid('Required test path is invalid.');
  }
  const normalized = path.posix.normalize(input);
  if (
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    path.posix.isAbsolute(normalized)
  ) {
    throw invalid('Required test path escapes workspace.');
  }
  return normalized;
}

function digest(input: unknown, label: string): string {
  const value = String(input ?? '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(value)) throw invalid(label + ' must be SHA-256.');
  return value;
}

function invalid(message: string): OperatorError {
  return new OperatorError('DEVELOPER_EDIT_WORKFLOW_INVALID', message);
}
