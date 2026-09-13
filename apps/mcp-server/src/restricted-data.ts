import path from 'node:path';
import { OperatorError } from '../../../src/core/errors.ts';

const SENSITIVE_BASENAMES: RegExp[] = [
  /^\.env(?:\..+)?$/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
  /^credentials(?:\..+)?$/i,
  /^service[-_.]?account.*\.json$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/i,
  /^authorized_keys$/i,
  /^kubeconfig$/i,
  /^wallet(?:\..+)?$/i,
  /^.*\.(?:pem|key|p12|pfx|kdbx)$/i
];

const SENSITIVE_SEGMENTS = new Set([
  '.ssh', '.aws', '.azure', '.gnupg', '.docker',
  'credentials', 'secrets', 'passwords'
]);

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\b(?:authorization|proxy-authorization)\s*:\s*(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\b(?:otp|one[- ]time(?: password| code)?|verification code)\s*[:=]\s*\d{4,10}\b/i,
  /\b(?:ssn|social security(?: number)?|aadhaar|aadhar|passport(?: number)?|driver'?s? license(?: number)?)\s*[:=]\s*[A-Za-z0-9 -]{5,32}\b/i,
  /\b(?:medical record(?: number)?|mrn|diagnosis|patient(?: name| id)|health insurance(?: number)?)\s*[:=]\s*[^\r\n]{2,96}/i,
  /\bDATABASE_URL\s*[:=]\s*["']?(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s"']+/i,
  /\b(?:API[_-]?KEY|ACCESS[_-]?TOKEN|AUTH[_-]?TOKEN|SECRET)\s*[:=]\s*["']?[A-Za-z0-9._~+\/=-]{12,}["']?/i,
  /\b(?:PASSWORD|PASSWD|PWD)\s*[:=]\s*["'][^"'\r\n]+["']/i
];
const SENSITIVE_KEYS = /(?:password|passwd|pwd|secret|token|api.?key|authorization|private.?key|otp|cvv|card.?number|ssn|social.?security|aadhaar|aadhar|passport|driver.?license|medical.?record|mrn|diagnosis|patient.?name|patient.?id|health.?insurance)/i;

export function assertPublicSafePath(input: string): void {
  const normalized = String(input ?? '').replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);
  const basename = segments.at(-1) ?? '';
  if (SENSITIVE_BASENAMES.some((pattern) => pattern.test(basename))) {
    throw new OperatorError('RESTRICTED_DATA_PATH_DENIED', 'The public plugin cannot access credential or secret-bearing files.');
  }
  if (segments.some((segment) => SENSITIVE_SEGMENTS.has(segment.toLowerCase()))) {
    throw new OperatorError('RESTRICTED_DATA_PATH_DENIED', 'The public plugin cannot access credential or secret-bearing directories.');
  }
}

export function containsRestrictedData(value: unknown, keyHint = ''): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') {
    if (keyHint && SENSITIVE_KEYS.test(keyHint) && value.length > 0) return true;
    if (SECRET_PATTERNS.some((pattern) => pattern.test(value))) return true;
    return containsPaymentCard(value);
  }
  if (Array.isArray(value)) return value.some((item) => containsRestrictedData(item, keyHint));
  if (typeof value !== 'object') return false;
  return Object.entries(value as Record<string, unknown>)
    .some(([key, item]) => containsRestrictedData(item, key));
}
export function assertNoRestrictedData(value: unknown): void {
  if (!containsRestrictedData(value)) return;
  throw new OperatorError(
    'RESTRICTED_DATA_BLOCKED',
    'The public plugin refused content that may contain credentials, payment data, authentication codes, or other restricted data.'
  );
}

export function isSensitiveEntryName(name: string): boolean {
  const base = path.basename(String(name ?? ''));
  return SENSITIVE_BASENAMES.some((pattern) => pattern.test(base))
    || SENSITIVE_SEGMENTS.has(base.toLowerCase());
}

function containsPaymentCard(text: string): boolean {
  const candidates = text.match(/(?:\d[ -]?){13,19}/g) ?? [];
  return candidates.some((candidate) => {
    const digits = candidate.replace(/\D/g, '');
    return digits.length >= 13 && digits.length <= 19 && luhn(digits);
  });
}

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let value = Number(digits[index]);
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}
