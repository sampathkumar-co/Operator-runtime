import crypto from 'node:crypto';
import { canonicalJson } from './action-identity.ts';
import { OperatorError } from './errors.ts';

export interface VerificationCheck {
  name: string;
  ok: boolean;
  detail: string;
  evidenceDigests?: string[];
}

export interface VerificationReceipt {
  version: 1;
  subjectKind: string;
  subjectId: string;
  contractDigest: string;
  checks: Array<{
    name: string;
    ok: boolean;
    detail: string;
    evidenceDigests: string[];
  }>;
  verified: boolean;
  digest: string;
}

function bounded(value: unknown, max: number, label: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || value.includes('\0')) {
    throw new OperatorError('VERIFICATION_INPUT_INVALID', `${label} is invalid.`);
  }
  return value;
}

function digestOf(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/** Reject holes and property accessors in proof-bearing arrays. */
function inertVerificationEnvelope(input: unknown): Record<'subjectKind' | 'subjectId' | 'contract' | 'checks', unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)) {
    throw new OperatorError('VERIFICATION_INPUT_INVALID', 'Verification request must be an inert plain object.');
  }
  const allowed = ['subjectKind', 'subjectId', 'contract', 'checks'];
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(input).length !== allowed.length ||
      Reflect.ownKeys(input).some(key => typeof key !== 'string' || !allowed.includes(key)) ||
      allowed.some(key => !Object.hasOwn(descriptors, key))) {
    throw new OperatorError('VERIFICATION_INPUT_INVALID', 'Verification request has missing or unsupported fields.');
  }
  const snapshot: Record<string, unknown> = Object.create(null);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || !('value' in descriptor)) {
      throw new OperatorError('VERIFICATION_INPUT_INVALID', 'Verification request contains an executable field.');
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot as Record<'subjectKind' | 'subjectId' | 'contract' | 'checks', unknown>;
}

function inertProofArray(input: unknown, min: number, max: number, label: string): unknown[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype ||
      input.length < min || input.length > max ||
      Reflect.ownKeys(input).length !== input.length + 1) {
    throw new OperatorError('VERIFICATION_INPUT_INVALID', `${label} must be a dense bounded array.`);
  }
  const values: unknown[] = [];
  for (let i = 0; i < input.length; i += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(i));
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      throw new OperatorError('VERIFICATION_INPUT_INVALID', `${label} contains a missing or executable slot.`);
    }
    values.push(descriptor.value);
  }
  return values;
}

function inertCheck(input: unknown, index: number): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)) {
    throw new OperatorError('VERIFICATION_INPUT_INVALID', `checks[${index}] must be an inert plain object.`);
  }
  const allowed = ['name', 'ok', 'detail', 'evidenceDigests'];
  const required = ['name', 'ok', 'detail'];
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(input).some(key => typeof key !== 'string' || !allowed.includes(key)) ||
      required.some(key => !Object.hasOwn(descriptors, key))) {
    throw new OperatorError('VERIFICATION_INPUT_INVALID', `checks[${index}] has missing or unsupported fields.`);
  }
  const result: Record<string, unknown> = Object.create(null);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || !('value' in descriptor)) {
      throw new OperatorError('VERIFICATION_INPUT_INVALID', `checks[${index}] contains an executable field.`);
    }
    result[key] = descriptor.value;
  }
  return result;
}

/**
 * Deterministic independent verification boundary.
 *
 * The kernel never executes the action being verified. It only binds a declared
 * contract to explicit pass/fail checks and evidence digests. Receipt identity is
 * stable across check ordering so crash/retry cannot manufacture a new outcome.
 */
export class VerificationKernel {
  verify(input: {
    subjectKind: string;
    subjectId: string;
    contract: unknown;
    checks: VerificationCheck[];
  }): VerificationReceipt {
    const request = inertVerificationEnvelope(input);
    const subjectKind = bounded(request.subjectKind, 128, 'subjectKind');
    const subjectId = bounded(request.subjectId, 512, 'subjectId');
    const suppliedChecks = inertProofArray(request.checks, 1, 10_000, 'checks');
    const names = new Set<string>();
    const checks = suppliedChecks.map((raw, index) => {
      // A forged getter-backed "ok" or an absent array slot must never
      // manufacture a successful independent verification receipt.
      const check = inertCheck(raw, index);
      if (typeof check.ok !== 'boolean') {
        throw new OperatorError('VERIFICATION_INPUT_INVALID',
          `checks[${index}].ok must be a literal boolean.`);
      }
      const name = bounded(check.name, 256, `checks[${index}].name`);
      if (names.has(name)) throw new OperatorError('VERIFICATION_INPUT_INVALID', `Duplicate verification check ${name}.`);
      names.add(name);
      const detail = bounded(check.detail, 16_384, `checks[${index}].detail`);
      const supplied = inertProofArray(check.evidenceDigests ?? [], 0, 1000,
        `checks[${index}].evidenceDigests`);
      if (supplied.some((value) => typeof value !== 'string' || !/^[0-9a-f]{64}$/i.test(value))) {
        throw new OperatorError('VERIFICATION_INPUT_INVALID', `checks[${index}].evidenceDigests are invalid.`);
      }
      const evidenceDigests = [...new Set(supplied.map((value) => (value as string).toLowerCase()))].sort();
      return { name, ok: check.ok, detail, evidenceDigests };
    }).sort((a, b) => a.name.localeCompare(b.name));

    const contractDigest = digestOf(request.contract);
    const base = {
      version: 1 as const,
      subjectKind,
      subjectId,
      contractDigest,
      checks,
      verified: checks.every((check) => check.ok)
    };
    return { ...base, digest: digestOf(base) };
  }
}
