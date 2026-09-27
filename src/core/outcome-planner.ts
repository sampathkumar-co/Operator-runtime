import crypto from 'node:crypto';
import { CAPABILITY_RISK_RULES } from './capability-policy.ts';
import { OperatorError } from './errors.ts';
import type { TeamBudget, TeamWorkInput } from './team-coordinator.ts';
import type { ActionRisk } from './types.ts';

const RISK_ORDER: readonly ActionRisk[] = ['read', 'write', 'external', 'system', 'destructive'];
const MAX_SUCCESS_CONDITIONS = 100;

export interface OutcomePlanInput {
  objective: string;
  scopeKey: string;
  successConditions: string[];
  maxRisk?: ActionRisk;
  availableCapabilities: string[];
  requestedCapabilities?: string[];
  resources?: string[];
  budget?: Partial<TeamBudget>;
}

export interface OutcomePlan {
  version: 1;
  kind: 'team';
  planDigest: string;
  maxRisk: ActionRisk;
  workItems: TeamWorkInput[];
  budget?: Partial<TeamBudget>;
  excludedDynamicCapabilities: string[];
}

export class OutcomePlanner {
  plan(input: OutcomePlanInput): OutcomePlan {
    const objective = boundedText(input.objective, 16_384, 'objective');
    const scopeKey = boundedContext(input.scopeKey, 'scopeKey');
    const successConditions = uniqueStrings(input.successConditions, MAX_SUCCESS_CONDITIONS, 4096, 'successConditions');
    if (successConditions.length < 1) throw new OperatorError('OUTCOME_PLAN_INVALID', 'At least one success condition is required.');
    const maxRisk = validRisk(input.maxRisk ?? 'read');
    const maxRiskIndex = RISK_ORDER.indexOf(maxRisk);
    const permissionRules = uniqueStrings(input.availableCapabilities, 500, 256, 'availableCapabilities');
    const requestedCapabilities = input.requestedCapabilities === undefined
      ? []
      : uniqueStrings(input.requestedCapabilities, 500, 256, 'requestedCapabilities');
    const resources = input.resources === undefined ? [] : uniqueStrings(input.resources, 5000, 1024, 'resources');
    if (maxRiskIndex > 0 && (requestedCapabilities.length === 0 || resources.length === 0)) {
      throw new OperatorError('OUTCOME_PLAN_AUTHORITY_REQUIRED', 'Outcome planning above read-only risk requires caller-declared capability and resource authority.');
    }
    const effectiveRules = requestedCapabilities.length > 0
      ? permissionRules.filter((capability) => requestedCapabilities.includes(capability))
      : permissionRules;

    const staticCapabilities = Object.entries(CAPABILITY_RISK_RULES)
      .filter(([, risk]) => risk !== 'dynamic')
      .filter(([capability]) => effectiveRules.some((rule) => capabilityAllowed(capability, rule)))
      .map(([capability, risk]) => ({ capability, risk: risk as ActionRisk }))
      .filter(({ risk }) => RISK_ORDER.indexOf(risk) <= maxRiskIndex);

    const readCapabilities = staticCapabilities
      .filter((item) => item.risk === 'read')
      .map((item) => item.capability)
      .sort();
    if (readCapabilities.length === 0) {
      throw new OperatorError('OUTCOME_PLAN_CAPABILITY_EMPTY', 'Outcome planning requires at least one already-authorized read capability.');
    }

    const excludedDynamicCapabilities = Object.entries(CAPABILITY_RISK_RULES)
      .filter(([, risk]) => risk === 'dynamic')
      .map(([capability]) => capability)
      .filter((capability) => permissionRules.some((rule) => capabilityAllowed(capability, rule)))
      .sort();

    const objectiveSummary = compact(objective, 1200);
    const conditionSummary = compact(successConditions.join('; '), 1600);
    const workItems: TeamWorkInput[] = [{
      key: 'plan',
      title: `Plan the bounded steps for objective "${objectiveSummary}" within scope ${scopeKey}. Success conditions: ${conditionSummary}. Do not widen authority; use only the capabilities on this work item.`,
      role: 'planner',
      risk: 'read',
      priority: 100,
      allowedCapabilities: readCapabilities,
      resources
    }];

    const executionKeys: string[] = [];
    for (const risk of RISK_ORDER.slice(1, maxRiskIndex + 1)) {
      const capabilities = staticCapabilities.filter((item) => item.risk === risk).map((item) => item.capability).sort();
      if (capabilities.length === 0) continue;
      const key = `execute-${risk}`;
      executionKeys.push(key);
      workItems.push({
        key,
        title: `Execute only the ${risk}-risk portion needed for objective "${objectiveSummary}". Consume the planner result from shared mission state, remain within scope ${scopeKey}, and stop rather than improvising authority.`,
        role: risk === 'write' ? 'coder' : risk === 'external' ? 'browser' : 'general',
        risk,
        priority: 80 - RISK_ORDER.indexOf(risk),
        dependsOn: ['plan', ...executionKeys.slice(0, -1)],
        allowedCapabilities: [...readCapabilities, ...capabilities].sort(),
        resources
      });
    }

    workItems.push({
      key: 'test',
      title: `Test the observable result for objective "${objectiveSummary}" against these success conditions: ${conditionSummary}. Report evidence, not self-asserted completion.`,
      role: 'tester',
      risk: 'read',
      priority: 20,
      dependsOn: executionKeys.length > 0 ? [...executionKeys] : ['plan'],
      allowedCapabilities: readCapabilities,
      resources
    });
    workItems.push({
      key: 'verify',
      title: `Independently verify the final state for objective "${objectiveSummary}" and all success conditions. Verification must be evidence-backed and must fail closed on ambiguity.`,
      role: 'verifier',
      risk: 'read',
      priority: 10,
      dependsOn: ['test'],
      allowedCapabilities: readCapabilities,
      resources
    });

    const canonical = {
      version: 1,
      kind: 'team',
      objective,
      scopeKey,
      successConditions,
      maxRisk,
      requestedCapabilities,
      resources,
      workItems,
      budget: input.budget ?? null,
      excludedDynamicCapabilities
    };
    return {
      version: 1,
      kind: 'team',
      planDigest: crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex'),
      maxRisk,
      workItems,
      ...(input.budget ? { budget: structuredClone(input.budget) } : {}),
      excludedDynamicCapabilities
    };
  }
}

function capabilityAllowed(capability: string, rule: string): boolean {
  return rule === capability || (rule.endsWith('.*') && capability.startsWith(rule.slice(0, -1)));
}

function validRisk(input: unknown): ActionRisk {
  const value = String(input ?? '') as ActionRisk;
  if (!RISK_ORDER.includes(value)) throw new OperatorError('OUTCOME_PLAN_INVALID', 'maxRisk is invalid.');
  return value;
}

function boundedContext(input: unknown, label: string): string {
  const value = boundedText(input, 512, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,511}$/.test(value)) throw new OperatorError('OUTCOME_PLAN_INVALID', `${label} is invalid.`);
  return value;
}

function uniqueStrings(input: unknown, maxItems: number, maxLength: number, label: string): string[] {
  if (!Array.isArray(input) || input.length > maxItems) throw new OperatorError('OUTCOME_PLAN_INVALID', `${label} is invalid.`);
  const values = input.map((value, index) => boundedText(value, maxLength, `${label}[${index}]`));
  if (new Set(values).size !== values.length) throw new OperatorError('OUTCOME_PLAN_INVALID', `${label} contains duplicates.`);
  return values;
}

function boundedText(input: unknown, max: number, label: string): string {
  if (typeof input !== 'string' || input.length < 1 || input.length > max || input.includes('\0')) {
    throw new OperatorError('OUTCOME_PLAN_INVALID', `${label} is invalid.`);
  }
  return input;
}

function compact(input: string, max: number): string {
  return input.length <= max ? input : input.slice(0, max - 1) + '…';
}
