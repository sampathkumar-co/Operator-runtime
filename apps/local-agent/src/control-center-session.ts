import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';

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

  /** Only call after a separate trusted native Windows owner gesture. */
  issueNativeOwnerSession(now = Date.now()): string {
    this.sweep(now);
    const secret = crypto.randomBytes(32).toString('base64url');
    if (this.sessions.size >= 16) {
      const oldest = this.sessions.keys().next().value;
      if (oldest) this.sessions.delete(oldest);
    }
    this.sessions.set(digest(secret), { idleUntil: now + SESSION_IDLE_MS, expiresAt: now + SESSION_ABSOLUTE_MS });
    return secret;
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
    return /^\/v1\/(?:tasks(?:\/[^/]+)?|teams(?:\/[^/]+)?|studio\/runs(?:\/[^/]+)?|desired-state(?:\/[^/]+)?|activity|devices|enterprise-policy|procedures|world\/entities|control-center\/(?:runtime|status|approvals|recovery|original-recovery\/browser|onboarding|diagnostics(?:\/export)?|tasks\/[0-9a-f-]{36}\/timeline))$/.test(pathname);
  }
  if (method === 'POST') {
    return pathname === '/v1/goals'
      || /^\/v1\/tasks\/[^/]+\/(?:run|pause|resume|cancel)$/.test(pathname)
      || /^\/v1\/teams\/[^/]+\/(?:start|pause|resume|cancel)$/.test(pathname)
      || /^\/v1\/studio\/workflows\/[^/]+\/run$/.test(pathname)
      || /^\/v1\/studio\/runs\/[^/]+\/(?:execute|cancel)$/.test(pathname)
      || pathname === '/v1/control-center/original-recovery/browser/resolve'
      || pathname === '/v1/desired-state'
      || /^\/v1\/desired-state\/[^/]+\/(?:reconcile|pause|resume)$/.test(pathname);
  }
  return false;
}


/** Terminal-free local Control Center login requires an independent Windows Yes/No gesture. */
export async function confirmLocalBrowserLoginOnWindows(): Promise<boolean> {
  if (process.platform !== 'win32' || process.env.MECORD_DISABLE_APPROVAL_UI === '1') return false;
  const systemRoot = String(process.env.SystemRoot ?? '').trim();
  if (!/^[A-Za-z]:\\Windows$/i.test(systemRoot)) return false;
  const executable = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    "$message = 'Allow this browser on the ORIGINAL Windows PC to sign in to Mecord Control Center? This only creates a time-limited dashboard session. It does NOT approve remote actions or recover protected receipts.'",
    "$response = [System.Windows.Forms.MessageBox]::Show($message,'Mecord Control Center sign-in',",
    '  [System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::Question,',
    '  [System.Windows.Forms.MessageBoxDefaultButton]::Button2)',
    "if ($response -eq [System.Windows.Forms.DialogResult]::Yes) { [Console]::Out.Write('YES'); exit 0 }",
    'exit 1'
  ].join('\r\n');
  return await new Promise<boolean>(resolve => {
    let settled = false;
    let stdout = '';
    const child = spawn(executable, [
      '-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-STA',
      '-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')
    ], { shell: false, windowsHide: true, stdio: ['ignore','pipe','ignore'] });
    const finish = (allowed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(allowed);
    };
    const timeout = setTimeout(() => { child.kill(); finish(false); }, 90_000);
    timeout.unref?.();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',(chunk: string) => {
      stdout += chunk;
      if (stdout.length > 12) { child.kill(); finish(false); }
    });
    child.once('error', () => finish(false));
    child.once('close', code => finish(code === 0 && stdout === 'YES'));
  });
}
