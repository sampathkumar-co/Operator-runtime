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
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new OperatorError('VERIFICATION_INPUT_INVALID', 'Verification request is invalid.');
    }
    const subjectKind = bounded(input.subjectKind, 128, 'subjectKind');
    const subjectId = bounded(input.subjectId, 512, 'subjectId');
    if (!Array.isArray(input.checks) || input.checks.length < 1 || input.checks.length > 10_000) {
      throw new OperatorError('VERIFICATION_INPUT_INVALID', 'Verification requires 1-10000 checks.');
    }

    const names = new Set<string>();
    const checks = input.checks.map((check, index) => {
      // A malformed or forged boolean must not silently become a failed check.
      // Preserve the typed proof contract even for callers bypassing TypeScript.
      if (!check || typeof check !== 'object' || Array.isArray(check) || typeof check.ok !== 'boolean') {
        throw new OperatorError('VERIFICATION_INPUT_INVALID', `checks[${index}] must be a typed verification check.`);
      }
      const name = bounded(check.name, 256, `checks[${index}].name`);
      if (names.has(name)) throw new OperatorError('VERIFICATION_INPUT_INVALID', `Duplicate verification check ${name}.`);
      names.add(name);
      const detail = bounded(check.detail, 16_384, `checks[${index}].detail`);
      // Proof identities are hexadecimal, so uppercase and lowercase refer to
      // the same digest. Validate and bound the raw list BEFORE deduplicating:
      // a hostile list of repeated entries must not bypass the input ceiling.
      const supplied = check.evidenceDigests ?? [];
      if (!Array.isArray(supplied) || supplied.length > 1000
        || supplied.some((value) => typeof value !== 'string' || !/^[0-9a-f]{64}$/i.test(value))) {
        throw new OperatorError('VERIFICATION_INPUT_INVALID', `checks[${index}].evidenceDigests are invalid.`);
      }
      const evidenceDigests = [...new Set(supplied.map((value) => value.toLowerCase()))].sort();
      return { name, ok: check.ok === true, detail, evidenceDigests };
    }).sort((a, b) => a.name.localeCompare(b.name));

    const contractDigest = digestOf(input.contract);
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
