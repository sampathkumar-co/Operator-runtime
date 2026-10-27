/**
 * C01 shared source-only evaluation input gate.
 *
 * Array.map/Array.every skip holes. Accessor-backed fixture records may run
 * arbitrary callbacks during provenance/score construction. Validate the
 * shape BEFORE any callbacks, model invocations, scorer reads, or provider
 * operations. This helper grants no tool authority and makes no claims of
 * independent scorer provenance.
 */
export function requireDenseEvaluationArray(value, min, max, failure, label) {
  if (!Array.isArray(value) || value.length < min || value.length > max ||
      Object.getPrototypeOf(value) !== Array.prototype ||
      Reflect.ownKeys(value).length !== value.length + 1) {
    failure(label + ' must be a dense bounded ordinary array');
  }
  for (let index = 0; index < value.length; index++) {
    const property = Object.getOwnPropertyDescriptor(value, String(index));
    if (!property || !property.enumerable || !('value' in property)) {
      failure(label + ' has a missing or executable element');
    }
  }
  return value;
}

export function requireInertEvaluationObject(value, failure, label, keys = undefined) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype &&
       Object.getPrototypeOf(value) !== null)) {
    failure(label + ' must be an inert plain object');
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || (keys && !keys.includes(key))) {
      failure(label + ' includes a forbidden field');
    }
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!property || !property.enumerable || !('value' in property)) {
      failure(label + ' contains an executable field');
    }
  }
  return value;
}

export function requireFrozenEvaluationCases(items, min, max, failure, label, fields) {
  requireDenseEvaluationArray(items, min, max, failure, label);
  for (const item of items) requireInertEvaluationObject(item, failure, label + ' entry', fields);
  return items;
}
