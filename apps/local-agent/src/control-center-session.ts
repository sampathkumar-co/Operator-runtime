import crypto from 'node:crypto';

export const CONTROL_CENTER_COOKIE = 'mecord_cc_session';
const CODE_LIFETIME_MS = 90_000;
const SESSION_IDLE_MS = 30 * 60_000;
const SESSION_ABSOLUTE_MS = 4 * 60 * 60_000;
const MAX_CODE_FAILURES = 5;

type Session = { idleUntil: number; expiresAt: number };

function digest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
function equalsDigest(a: string, b: string): boolean {
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/**
 * Ephemeral, process-local browser authority. Never returns the internal agent
 * bearer token or recovery token to the browser.
 */
export class ControlCenterSessions {
  private loginCodeHash: string | null = null;
  private codeExpiresAt = 0;
  private failures = 0;
  private readonly sessions = new Map<string, Session>();

  issueCode(now = Date.now()): { code: string; expiresAt: string } {
    const code = crypto.randomBytes(12).toString('base64url');
    this.loginCodeHash = digest(code);
    this.codeExpiresAt = now + CODE_LIFETIME_MS;
    this.failures = 0;
    return { code, expiresAt: new Date(this.codeExpiresAt).toISOString() };
  }

  redeemCode(input: unknown, now = Date.now()): string | null {
    if (!this.loginCodeHash || now >= this.codeExpiresAt || this.failures >= MAX_CODE_FAILURES) return null;
    const proposed = typeof input === 'string' && /^[A-Za-z0-9_-]{16}$/.test(input)
      ? digest(input) : digest('invalid-code');
    if (!equalsDigest(proposed, this.loginCodeHash)) {
      this.failures += 1;
      return null;
    }
    this.loginCodeHash = null;
    this.codeExpiresAt = 0;
    this.failures = 0;
    this.sweep(now);
    const sessionSecret = crypto.randomBytes(32).toString('base64url');
    if (this.sessions.size >= 16) {
      const oldest = this.sessions.keys().next().value;
      if (oldest) this.sessions.delete(oldest);
    }
    this.sessions.set(digest(sessionSecret), { idleUntil: now + SESSION_IDLE_MS, expiresAt: now + SESSION_ABSOLUTE_MS });
    return sessionSecret;
  }

  validCookie(cookieHeader: string | undefined, now = Date.now()): string | null {
    if (!cookieHeader || cookieHeader.length > 4096) return null;
    const parts = cookieHeader.split(';').map((item) => item.trim());
    const matching = parts.filter((item) => item.startsWith(CONTROL_CENTER_COOKIE + '='));
    if (matching.length !== 1) return null;
    const raw = matching[0]!.slice(CONTROL_CENTER_COOKIE.length + 1);
    if (!/^[A-Za-z0-9_-]{43}$/.test(raw)) return null;
    const key = digest(raw);
    const record = this.sessions.get(key);
    if (!record) return null;
    if (now >= record.idleUntil || now >= record.expiresAt) {
      this.sessions.delete(key);
      return null;
    }
    record.idleUntil = Math.min(now + SESSION_IDLE_MS, record.expiresAt);
    return key;
  }

  revoke(sessionKey: string): void {
    this.sessions.delete(sessionKey);
  }

  cookie(secret: string): string {
    return `${CONTROL_CENTER_COOKIE}=${secret}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_ABSOLUTE_MS / 1000}`;
  }

  expiredCookie(): string {
    return `${CONTROL_CENTER_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
  }

  private sweep(now: number): void {
    for (const [key, value] of this.sessions) {
      if (now >= value.idleUntil || now >= value.expiresAt) this.sessions.delete(key);
    }
  }
}

/** Requests must originate from the literal local dashboard, not DNS-rebound or third-party pages. */
export function controlCenterBrowserRequestAllowed(
  headers: Record<string, string | string[] | undefined>,
  port: number,
  mutation: boolean
): boolean {
  const expectedOrigin = `http://127.0.0.1:${port}`;
  if (headers.host !== `127.0.0.1:${port}`) return false;
  if (headers['sec-fetch-site'] && headers['sec-fetch-site'] !== 'same-origin') return false;
  if (mutation) {
    if (headers.origin !== expectedOrigin || headers['x-mecord-control-center'] !== '1') return false;
  } else if (headers.origin && headers.origin !== expectedOrigin) return false;
  return true;
}

/** Only routes actually used by the browser UI get cookie-based authority. */
export function browserUiRouteAllowed(method: string, pathname: string): boolean {
  if (method === 'GET') {
    return /^\/v1\/(?:tasks(?:\/[^/]+)?|teams(?:\/[^/]+)?|studio\/runs(?:\/[^/]+)?|desired-state(?:\/[^/]+)?|activity|devices|enterprise-policy|procedures|world\/entities|control-center\/(?:runtime|status|approvals|recovery|original-recovery/browser|onboarding|diagnostics(?:\/export)?|tasks\/[0-9a-f-]{36}\/timeline))$/.test(pathname);
  }
  if (method === 'POST') {
    return pathname === '/v1/goals'
      || /^\/v1\/tasks\/[^/]+\/(?:run|pause|resume|cancel)$/.test(pathname)
      || /^\/v1\/teams\/[^/]+\/(?:start|pause|resume|cancel)$/.test(pathname)
      || /^\/v1\/studio\/workflows\/[^/]+\/run$/.test(pathname)
      || /^\/v1\/studio\/runs\/[^/]+\/(?:execute|cancel)$/.test(pathname)
      || pathname === '/v1/desired-state'
      || /^\/v1\/desired-state\/[^/]+\/(?:reconcile|pause|resume)$/.test(pathname);
  }
  return false;
}
