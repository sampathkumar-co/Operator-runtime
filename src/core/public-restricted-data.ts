import path from 'node:path';
import { OperatorError } from './errors.ts';

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
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}\b/,
  /\bsk_(?:live|test)_[0-9A-Za-z]{16,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\b(?:authorization|proxy-authorization)\s*:\s*(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/?#]+:[^\s@/?#]+@[^\s"']+/i,
  /\b(?:otp|one[- ]time(?: password| code)?|verification code|recovery code)\s*[:=]\s*[A-Za-z0-9-]{4,20}\b/i,
  /\b(?:ssn|social security(?: number)?|aadhaar|aadhar|passport(?: number)?|driver'?s? license(?: number)?)\s*[:=]\s*[A-Za-z0-9 -]{5,32}\b/i,
  /\b(?:medical record(?: number)?|mrn|diagnosis|patient(?: name| id)|health insurance(?: number)?)\s*[:=]\s*[^\r\n]{2,96}/i,
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|mssql|redis):\/\/[^\s:@/]+:[^\s@/]+@[^\s"']+/i,
  /\b(?:DATABASE_URL|REDIS_URL|MONGODB_URI)\s*[:=]\s*["']?[^\s"']+:[^\s"']+@[^\s"']+/i,
  /\b(?:API[_-]?KEY|APIKEY|ACCESS[_-]?KEY(?:_ID)?|SECRET[_-]?KEY|CLIENT[_-]?SECRET|ACCESS[_-]?TOKEN|REFRESH[_-]?TOKEN|AUTH[_-]?TOKEN|_AUTH(?:TOKEN)?|NPM_TOKEN)\s*[:=]\s*["']?[^\s"']{8,}["']?/i,
  /\bAWS_SECRET_ACCESS_KEY\s*[:=]\s*["']?[A-Za-z0-9/+=]{20,}["']?/i,
  /\b(?:PASSWORD|PASSWD|PWD)\s*[:=]\s*["']?[^\s"';,}{]{4,}["']?/i,
  /\b(?:AccountKey|SharedAccessKey)\s*=\s*[A-Za-z0-9+/=]{16,}/i,
  /\b(?:session|sessionid|session_id|auth_cookie|cookie)\s*[:=]\s*["']?[A-Za-z0-9._~+%/=-]{12,}["']?/i
];
const SENSITIVE_KEYS = /(?:password|passwd|pwd|secret|credential|token|api.?key|access.?key|client.?secret|authorization|private.?key|otp|cvv|card.?number|ssn|social.?security|aadhaar|aadhar|passport|driver.?license|medical.?record|mrn|diagnosis|patient.?name|patient.?id|health.?insurance|account.?key|cookie|session)/i;

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
    if (keyHint && isRestrictedDataKey(keyHint) && value.length > 0) return true;
    return containsRestrictedString(value);
  }
  if (Array.isArray(value)) return value.some((item) => containsRestrictedData(item, keyHint));
  if (typeof value !== 'object') return false;
  return Object.entries(value as Record<string, unknown>)
    .some(([key, item]) => containsRestrictedData(item, key));
}

/** Value-level restricted-data recognition for sinks that must redact instead of reject. */
export function containsRestrictedString(value: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(value)) || containsPaymentCard(value);
}

/** Canonical restricted-data key recognition shared by rejecting and redacting boundaries. */
export function isRestrictedDataKey(key: string): boolean {
  return SENSITIVE_KEYS.test(key);
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
  // Luhn alone is not sufficient: timestamps, inode-like identifiers and other
  // numeric telemetry can satisfy it by chance. Require a standalone numeric
  // token plus a plausible payment-network issuer prefix before applying Luhn.
  const candidates = text.match(/(?<![A-Za-z0-9])(?:\d[ -]?){13,19}(?![A-Za-z0-9])/g) ?? [];
  return candidates.some((candidate) => {
    const digits = candidate.replace(/\D/g, '');
    return plausiblePaymentCardIssuer(digits) && luhn(digits);
  });
}

function plausiblePaymentCardIssuer(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  const prefix2 = Number(digits.slice(0, 2));
  const prefix3 = Number(digits.slice(0, 3));
  const prefix4 = Number(digits.slice(0, 4));
  const prefix6 = Number(digits.slice(0, 6));

  // Visa.
  if (digits.startsWith('4') && [13, 16, 19].includes(digits.length)) return true;
  // Mastercard legacy and 2-series.
  if (digits.length === 16 && ((prefix2 >= 51 && prefix2 <= 55) || (prefix4 >= 2221 && prefix4 <= 2720))) return true;
  // American Express.
  if (digits.length === 15 && (prefix2 === 34 || prefix2 === 37)) return true;
  // Discover.
  if ([16, 17, 18, 19].includes(digits.length)
    && (digits.startsWith('6011') || prefix2 === 65 || (prefix3 >= 644 && prefix3 <= 649) || (prefix6 >= 622126 && prefix6 <= 622925))) return true;
  // JCB.
  if ([16, 17, 18, 19].includes(digits.length) && prefix4 >= 3528 && prefix4 <= 3589) return true;
  // Diners Club.
  if (digits.length === 14 && ((prefix3 >= 300 && prefix3 <= 305) || [36, 38, 39].includes(prefix2))) return true;
  return false;
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
