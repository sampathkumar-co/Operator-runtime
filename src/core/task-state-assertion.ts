import { canonicalJson } from './action-identity.ts';
import { OperatorError } from './errors.ts';

export type TaskStateAssertion = {
  path: string;
  operator: 'exists' | 'equals' | 'not_equals' | 'includes';
  value?: unknown;
};

export function normalizeTaskStateAssertions(input: unknown, label = 'assertions'): TaskStateAssertion[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 20) {
    throw new OperatorError('TASK_GOAL_INVALID', `${label} must contain 1-20 machine-state assertions.`);
  }
  return input.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new OperatorError('TASK_GOAL_INVALID', `${label}[${index}] is invalid.`);
    const raw = item as Record<string, unknown>;
    const path = String(raw.path ?? '');
    if (path.length < 1 || path.length > 256 || !path.split('.').every((part) => /^[A-Za-z0-9_-]{1,64}$/.test(part))) {
      throw new OperatorError('TASK_GOAL_INVALID', `${label}[${index}].path is invalid.`);
    }
    const operator = String(raw.operator ?? '') as TaskStateAssertion['operator'];
    if (!['exists', 'equals', 'not_equals', 'includes'].includes(operator)) throw new OperatorError('TASK_GOAL_INVALID', `${label}[${index}].operator is invalid.`);
    if (operator !== 'exists' && raw.value === undefined) throw new OperatorError('TASK_GOAL_INVALID', `${label}[${index}] requires value.`);
    if (raw.value !== undefined && Buffer.byteLength(canonicalJson(raw.value)) > 16 * 1024) throw new OperatorError('TASK_GOAL_INVALID', `${label}[${index}].value is too large.`);
    return { path, operator, ...(raw.value === undefined ? {} : { value: structuredClone(raw.value) }) };
  });
}

export function assertTaskMachineState(state: Record<string, unknown>, assertions: TaskStateAssertion[]): void {
  for (const assertion of assertions) {
    const resolved = resolvePath(state, assertion.path);
    let passed = false;
    if (assertion.operator === 'exists') passed = resolved.found;
    else if (assertion.operator === 'equals') passed = resolved.found && canonicalJson(resolved.value) === canonicalJson(assertion.value);
    else if (assertion.operator === 'not_equals') passed = !resolved.found || canonicalJson(resolved.value) !== canonicalJson(assertion.value);
    else if (assertion.operator === 'includes') passed = resolved.found && Array.isArray(resolved.value)
      && resolved.value.some((item) => canonicalJson(item) === canonicalJson(assertion.value));
    if (!passed) throw new OperatorError('TASK_AUTONOMOUS_VERIFICATION_FAILED', `Machine-state assertion failed: ${assertion.path} ${assertion.operator}.`);
  }
}

function resolvePath(root: Record<string, unknown>, dotted: string): { found: boolean; value?: unknown } {
  let current: unknown = root;
  for (const part of dotted.split('.')) {
    if (!current || typeof current !== 'object' || Array.isArray(current) || !Object.prototype.hasOwnProperty.call(current, part)) return { found: false };
    current = (current as Record<string, unknown>)[part];
  }
  return { found: true, value: current };
}
