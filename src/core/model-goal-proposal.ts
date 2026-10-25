import path from 'node:path';
import { OperatorError } from './errors.ts';
import type { SemanticTaskGoal } from './task-orchestrator-contracts.ts';

type NavigationGoal = Extract<SemanticTaskGoal, { kind: 'browser-navigation' }>;
type ProjectCommandGoal = Extract<SemanticTaskGoal, { kind: 'trusted-project-command' }>;
type ProjectQualityGateGoal = Extract<SemanticTaskGoal, { kind: 'project-quality-gate' }>;
type AtomicProposal = NavigationGoal | ProjectCommandGoal;
export type ValidatedModelGoal = AtomicProposal
  | ProjectQualityGateGoal
  | { kind: 'semantic-workflow'; steps: AtomicProposal[] };

export interface ModelGoalProposalRequest {
  objective: string;
  approvedRoots: string[];
  approvedBrowserOrigins: string[];
}
export interface ValidatedModelGoalProposal {
  goal: ValidatedModelGoal;
  successConditions: string[];
}

function invalid(message: string): never {
  throw new OperatorError('TASK_PROPOSAL_INVALID', message);
}
function denied(message: string): never {
  throw new OperatorError('TASK_PROPOSAL_SCOPE_DENIED', message);
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    invalid(label + ' must be a plain JSON object.');
  }
  return value as Record<string, unknown>;
}
function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) invalid(label + ' contains an unsupported field.');
  }
}
function boundedText(value: unknown, limit: number, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit ||
      value.includes('\0')) invalid(label + ' is invalid.');
  return value.trim();
}
function approvedOrigin(value: unknown): string {
  const text = boundedText(value, 2048, 'approved origin');
  let parsed: URL;
  try { parsed = new URL(text); }
  catch { return invalid('Approved browser origin must be an absolute URL.'); }
  if (!['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username || parsed.password || parsed.origin !== text ||
      parsed.pathname !== '/' || parsed.search || parsed.hash) {
    invalid('Approved browser scope must be an exact credential-free HTTP(S) origin.');
  }
  return parsed.origin;
}
function approvedRoot(value: unknown): string {
  const root = boundedText(value, 4096, 'approved project root');
  if (!path.isAbsolute(root)) invalid('Approved project roots must be absolute paths.');
  return path.resolve(root);
}
function within(candidate: string, root: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}
function scopes(input: ModelGoalProposalRequest) {
  if (!input || typeof input !== 'object' || !Array.isArray(input.approvedRoots) ||
      !Array.isArray(input.approvedBrowserOrigins) ||
      input.approvedRoots.length > 12 || input.approvedBrowserOrigins.length > 12 ||
      input.approvedRoots.length + input.approvedBrowserOrigins.length === 0) {
    denied('Provide bounded explicit user-approved browser origins or project roots.');
  }
  boundedText(input.objective, 4096, 'objective');
  return {
    roots: input.approvedRoots.map(approvedRoot),
    origins: new Set(input.approvedBrowserOrigins.map(approvedOrigin))
  };
}
type Scope = ReturnType<typeof scopes>;
function atomic(value: unknown, scope: Scope): AtomicProposal {
  const source = object(value, 'Model atomic goal');
  if (!Object.hasOwn(source, 'kind')) invalid('Model atomic goal must declare its own kind.');
  if (source.kind === 'browser-navigation') {
    onlyKeys(source, ['kind', 'url'], 'browser-navigation');
    const target = boundedText(source.url, 4096, 'browser target');
    let url: URL;
    try { url = new URL(target); }
    catch { return invalid('Model browser URL is invalid.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
        !scope.origins.has(url.origin)) {
      denied('Model-proposed browser navigation exceeds approved browser origins.');
    }
    return { kind: 'browser-navigation', url: url.toString() };
  }
  if (source.kind === 'trusted-project-command') {
    onlyKeys(source, ['kind', 'root', 'commandKind'], 'trusted-project-command');
    const rawRoot = boundedText(source.root, 4096, 'command root');
    if (!path.isAbsolute(rawRoot)) invalid('Model command root must be absolute.');
    const root = path.resolve(rawRoot);
    if (!scope.roots.some(approved => within(root, approved))) {
      denied('Model-proposed project command exceeds approved roots.');
    }
    if (source.commandKind !== 'lint' && source.commandKind !== 'test' && source.commandKind !== 'build') {
      invalid('Model may propose only a registered lint/test/build command.');
    }
    return { kind: 'trusted-project-command', root, commandKind: source.commandKind };
  }
  invalid('Model may propose only scoped navigation and registered project command steps.');
}
/**
 * Pure preflight validator for untrusted model JSON. It does not invoke a model,
 * submit tasks, discover a browser target, authorize resources, or verify success.
 * Runtime dispatch must always recheck fresh policy/root/target and obtain approval.
 */
export function validateModelGoalProposal(
  value: unknown, request: ModelGoalProposalRequest
): ValidatedModelGoalProposal {
  const scope = scopes(request);
  const response = object(value, 'Model proposal');
  onlyKeys(response, ['goal', 'successConditions'], 'Model proposal');
  if (!Object.hasOwn(response, 'goal') || !Object.hasOwn(response, 'successConditions')) {
    invalid('Model proposal must own goal and successConditions fields.');
  }
  const source = object(response.goal, 'Model goal');
  if (!Object.hasOwn(source, 'kind')) invalid('Model goal must declare its own kind.');
  let goal: ValidatedModelGoal;
  if (source.kind === 'semantic-workflow') {
    onlyKeys(source, ['kind', 'steps'], 'semantic-workflow');
    if (!Array.isArray(source.steps) || source.steps.length < 2 || source.steps.length > 4) {
      invalid('Model workflows must have 2-4 typed steps.');
    }
    const steps = source.steps.map(step => atomic(step, scope));
    if (new Set(steps.map(step => JSON.stringify(step))).size !== steps.length) {
      invalid('A model workflow must not repeat an identical step.');
    }
    goal = { kind: 'semantic-workflow', steps };
  } else if (source.kind === 'project-quality-gate') {
    onlyKeys(source, ['kind', 'root', 'checks', 'requireAll'], 'project-quality-gate');
    const rawRoot = boundedText(source.root, 4096, 'quality gate root');
    if (!path.isAbsolute(rawRoot)) invalid('Quality gate root must be absolute.');
    const root = path.resolve(rawRoot);
    if (!scope.roots.some(approved => within(root, approved))) {
      denied('Model quality gate exceeds approved roots.');
    }
    if (!Array.isArray(source.checks) || source.checks.length < 2 || source.checks.length > 3 ||
        source.checks.some(check => check !== 'test' && check !== 'build' && check !== 'lint') ||
        new Set(source.checks).size !== source.checks.length || source.requireAll !== true) {
      invalid('Quality gates require 2-3 distinct registered checks and requireAll:true.');
    }
    goal = {
      kind: 'project-quality-gate', root,
      checks: source.checks as Array<'test' | 'build' | 'lint'>,
      requireAll: true
    };
  } else {
    goal = atomic(source, scope);
  }
  if (!Array.isArray(response.successConditions) || response.successConditions.length < 1 ||
      response.successConditions.length > 5) {
    invalid('Model must supply 1-5 observable success conditions.');
  }
  const successConditions = response.successConditions.map((entry, index) =>
    boundedText(entry, 512, 'successConditions[' + index + ']'));
  return { goal, successConditions };
}
