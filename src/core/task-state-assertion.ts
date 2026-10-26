import { canonicalJson } from './action-identity.ts';
import { OperatorError } from './errors.ts';

export type TaskStateAssertion = {
  path: string;
  operator: 'exists' | 'equals' | 'not_equals' | 'includes';
  value?: unknown;
};

/**
 * Assertion values become proof bytes. Reject JavaScript-only data BEFORE
 * canonical JSON encoding: NaN/Infinity turn into null, sparse arrays become
 * null-filled arrays, and undefined/function-valued object properties vanish.
 * These collisions could otherwise let a malformed expectation match a
 * different observed machine value during independent verification.
 */
function normalizeAssertionValue(value: unknown, label: string): unknown {
  let visitedNodes = 0;
  const ancestors = new Set<object>();
  const fail = (): never => {
    throw new OperatorError('TASK_GOAL_INVALID', `${label} must be bounded inert JSON data.`);
  };
  function inspect(node: unknown, depth: number): void {
    if (++visitedNodes > 4096 || depth > 16) fail();
    if (node === null || typeof node === 'boolean' || typeof node === 'string') return;
    if (typeof node === 'number' && Number.isFinite(node)) return;
    if (node === null || typeof node !== 'object') return fail();
    if (ancestors.has(node)) return fail();
    const array = Array.isArray(node);
    const prototype = Object.getPrototypeOf(node);
    if (!array && prototype !== Object.prototype && prototype !== null) fail();
    const keys = Reflect.ownKeys(node);
    if (keys.length > 4097 || keys.some(key => typeof key !== 'string')) fail();
    if (array) {
      if ((node as unknown[]).length > 4096) fail();
      for (let i = 0; i < (node as unknown[]).length; i += 1) {
        if (!Object.hasOwn(node, i)) fail();
      }
    }
    ancestors.add(node);
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (array && (!/^(?:0|[1-9][0-9]*)$/.test(key as string) ||
          Number(key) >= (node as unknown[]).length)) fail();
      const descriptor = Object.getOwnPropertyDescriptor(node, key);
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return fail();
      inspect(descriptor.value, depth + 1);
    }
    ancestors.delete(node);
  }
  inspect(value, 0);
  const json = canonicalJson(value);
  if (Buffer.byteLength(json, 'utf8') > 16 * 1024) {
    throw new OperatorError('TASK_GOAL_INVALID', `${label} is too large.`);
  }
  return JSON.parse(json);
}

/**
 * Proof checks must be an exact JSON-shaped list. Sparse slots are skipped by
 * Array.map, and JS-only hidden/accessor fields cannot be authenticated in a
 * canonical JSON assertion digest.
 */
function exactAssertionList(input: unknown, label: string): asserts input is unknown[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype ||
      input.length < 1 || input.length > 20 ||
      Reflect.ownKeys(input).length !== input.length + 1) {
    throw new OperatorError('TASK_GOAL_INVALID', `${label} must be an exact dense list of 1-20 assertions.`);
  }
  for (let index = 0; index < input.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      throw new OperatorError('TASK_GOAL_INVALID', `${label} contains a missing or executable assertion slot.`);
    }
  }
}

function exactAssertionRecord(input: Record<string, unknown>, label: string): void {
  const proto = Object.getPrototypeOf(input);
  if ((proto !== Object.prototype && proto !== null) ||
      Reflect.ownKeys(input).some(key => typeof key !== 'string' ||
        !['path', 'operator', 'value'].includes(key))) {
    throw new OperatorError('TASK_GOAL_INVALID', `${label} must contain only typed assertion fields.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (!Object.hasOwn(descriptors, 'path') || !Object.hasOwn(descriptors, 'operator') ||
      Object.values(descriptors).some(desc => !('value' in desc) || !desc.enumerable)) {
    throw new OperatorError('TASK_GOAL_INVALID', `${label} contains missing or executable fields.`);
  }
}

export function normalizeTaskStateAssertions(input: unknown, label = 'assertions'): TaskStateAssertion[] {
  exactAssertionList(input, label);
  return input.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new OperatorError('TASK_GOAL_INVALID', `${label}[${index}] is invalid.`);
    const raw = item as Record<string, unknown>;
    exactAssertionRecord(raw, `${label}[${index}]`);
    // An array/object converted through String() is not a typed assertion.
    // Its accidental coercion must not become a different machine-state path
    // or turn an unrecognised operation into an accepted comparison.
    const path = raw.path;
    if (typeof path !== 'string' || path.length < 1 || path.length > 256 ||
        !path.split('.').every((part) => /^[A-Za-z0-9_-]{1,64}$/.test(part))) {
      throw new OperatorError('TASK_GOAL_INVALID', `${label}[${index}].path is invalid.`);
    }
    const operator = raw.operator;
    if (typeof operator !== 'string' || !['exists', 'equals', 'not_equals', 'includes'].includes(operator)) {
      throw new OperatorError('TASK_GOAL_INVALID', `${label}[${index}].operator is invalid.`);
    }
    if (operator === 'exists' && Object.hasOwn(raw, 'value')) {
      throw new OperatorError('TASK_GOAL_INVALID', `${label}[${index}] exists checks cannot carry ignored values.`);
    }
    if (operator !== 'exists' && !Object.hasOwn(raw, 'value')) {
      throw new OperatorError('TASK_GOAL_INVALID', `${label}[${index}] requires value.`);
    }
    const value = operator === 'exists'
      ? undefined : normalizeAssertionValue(raw.value, `${label}[${index}].value`);
    return { path, operator: operator as TaskStateAssertion['operator'],
      ...(value === undefined ? {} : { value }) };
  });
}

export function assertTaskMachineState(state: Record<string, unknown>, assertions: TaskStateAssertion[]): void {
  for (const assertion of assertions) {
    const resolved = resolvePath(state, assertion.path);
    let passed = false;
    if (assertion.operator === 'exists') passed = resolved.found;
    else if (assertion.operator === 'equals') passed = resolved.found && canonicalJson(resolved.value) === canonicalJson(assertion.value);
    else if (assertion.operator === 'not_equals') passed = resolved.found && canonicalJson(resolved.value) !== canonicalJson(assertion.value);
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
