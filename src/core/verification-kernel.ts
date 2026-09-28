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
    const subjectKind = bounded(input.subjectKind, 128, 'subjectKind');
    const subjectId = bounded(input.subjectId, 512, 'subjectId');
    if (!Array.isArray(input.checks) || input.checks.length < 1 || input.checks.length > 10_000) {
      throw new OperatorError('VERIFICATION_INPUT_INVALID', 'Verification requires 1-10000 checks.');
    }

    const names = new Set<string>();
    const checks = input.checks.map((check, index) => {
      const name = bounded(check.name, 256, `checks[${index}].name`);
      if (names.has(name)) throw new OperatorError('VERIFICATION_INPUT_INVALID', `Duplicate verification check ${name}.`);
      names.add(name);
      const detail = bounded(check.detail, 16_384, `checks[${index}].detail`);
      const evidenceDigests = [...new Set(check.evidenceDigests ?? [])].sort();
      if (evidenceDigests.length > 1000 || evidenceDigests.some((value) => !/^[0-9a-f]{64}$/i.test(value))) {
        throw new OperatorError('VERIFICATION_INPUT_INVALID', `checks[${index}].evidenceDigests are invalid.`);
      }
      return { name, ok: check.ok === true, detail, evidenceDigests: evidenceDigests.map((value) => value.toLowerCase()) };
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
