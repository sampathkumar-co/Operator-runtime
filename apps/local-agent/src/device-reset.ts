import fs from 'node:fs/promises';
import path from 'node:path';
import type { DeviceIdentityStore } from '../../../src/core/device-identity.ts';
import { OperatorError } from '../../../src/core/errors.ts';
import { readDurableStateText, writeDurableStateText } from '../../../src/core/durable-state.ts';

const MAX_JOURNAL_BYTES = 64 * 1024;
const MAX_TREE_ENTRIES = 10_000;

interface LocalResetJournal {
  version: 1;
  deviceId: string;
  phase: 'HOSTED_REVOKED' | 'COMPLETE';
  hostedStatus: 'revoked' | 'not-configured';
  hostedCompletedAt: string;
  updatedAt: string;
}

export interface LocalDeviceResetResult {
  status: 'complete';
  deviceId?: string;
  hostedStatus: 'revoked' | 'not-configured' | 'not-applicable';
  removedTargets: string[];
}
export interface LocalDeviceResetOptions {
  stateDir: string;
  identity: DeviceIdentityStore;
  resetUrl?: string;
  getResetToken?: () => Promise<string>;
  stopRelay?: () => Promise<void> | void;
  fetchImpl?: typeof fetch;
  clock?: () => Date;
}

export class LocalDeviceResetCoordinator {
  #stateDir: string;
  #journalFile: string;
  #identity: DeviceIdentityStore;
  #resetUrl?: string;
  #getResetToken?: () => Promise<string>;
  #stopRelay?: () => Promise<void> | void;
  #fetch: typeof fetch;
  #clock: () => Date;
  #queue: Promise<void> = Promise.resolve();

  constructor(options: LocalDeviceResetOptions) {
    this.#stateDir = path.resolve(options.stateDir);
    this.#journalFile = path.join(this.#stateDir, 'local-device-reset.json');
    this.#identity = options.identity;
    this.#resetUrl = options.resetUrl === undefined ? undefined : validateResetUrl(options.resetUrl);
    this.#getResetToken = options.getResetToken;
    this.#stopRelay = options.stopRelay;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#clock = options.clock ?? (() => new Date());
    if (this.#resetUrl && !this.#getResetToken) {
      throw new OperatorError('DEVICE_RESET_CONFIG_INVALID', 'Hosted device reset requires a relay reset credential provider.');
    }
  }

  async reset(): Promise<LocalDeviceResetResult> {
    return await this.#exclusive(async () => {
      const identity = await this.#identity.loadExisting();
      const journal = await this.#readJournal();
      if (!identity && journal?.phase === 'COMPLETE') {
        return { status: 'complete', deviceId: journal.deviceId, hostedStatus: journal.hostedStatus, removedTargets: [] };
      }
      if (!identity && !journal) {
        return { status: 'complete', hostedStatus: 'not-applicable', removedTargets: [] };
      }

      const deviceId = identity?.deviceId ?? journal!.deviceId;
      let activeJournal = journal?.deviceId === deviceId && journal.phase === 'HOSTED_REVOKED' ? journal : null;
      if (!activeJournal) activeJournal = await this.#revokeHosted(deviceId);
      const removedTargets = await this.#purgeLocalAuthority();
      await this.#identity.erase();
      const completed: LocalResetJournal = {
        ...activeJournal,
        phase: 'COMPLETE',
        updatedAt: this.#clock().toISOString()
      };
      await this.#writeJournal(completed);
      return { status: 'complete', deviceId, hostedStatus: completed.hostedStatus, removedTargets };
    });
  }

  async #revokeHosted(deviceId: string): Promise<LocalResetJournal> {
    if (!this.#resetUrl) {
      await this.#stopRelay?.();
      const now = this.#clock().toISOString();
      const journal: LocalResetJournal = { version: 1, deviceId, phase: 'HOSTED_REVOKED', hostedStatus: 'not-configured', hostedCompletedAt: now, updatedAt: now };
      await this.#writeJournal(journal);
      return journal;
    }
    const token = await this.#getResetToken!();
    await this.#stopRelay?.();
    let response: Response;
    try {
      response = await this.#fetch(this.#resetUrl, { method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
    } catch (error) {
      throw new OperatorError('DEVICE_RESET_HOSTED_FAILED', `Hosted device reset request failed: ${error instanceof Error ? error.message : String(error)}`, { retryable: true });
    }
    let body: any = null;
    try { body = await response.json(); } catch { /* handled below */ }
    if (response.status !== 200 || body?.ok !== true || body?.reset?.status !== 'complete') {
      const code = String(body?.error?.code ?? 'DEVICE_RESET_HOSTED_FAILED');
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      throw new OperatorError(code, `Hosted device reset failed with HTTP ${response.status}.`, { retryable });
    }
    const returnedDeviceId = validUuid(String(body.reset.deviceId ?? ''), 'hosted reset deviceId');
    if (returnedDeviceId !== deviceId) throw new OperatorError('DEVICE_RESET_RECEIPT_MISMATCH', 'Hosted reset receipt belongs to a different device.');
    const completedAt = validIso(String(body.reset.completedAt ?? ''), 'hosted reset completion');
    const now = this.#clock().toISOString();
    const journal: LocalResetJournal = {
      version: 1,
      deviceId,
      phase: 'HOSTED_REVOKED',
      hostedStatus: 'revoked',
      hostedCompletedAt: completedAt,
      updatedAt: now
    };
    await this.#writeJournal(journal);
    return journal;
  }

  async #purgeLocalAuthority(): Promise<string[]> {
    const relatives = authorityTargets();
    for (const relative of relatives) await this.#assertSafeTarget(this.#target(relative));
    const removed: string[] = [];
    for (const relative of relatives) {
      const target = this.#target(relative);
      try {
        await fs.lstat(target);
        await fs.rm(target, { recursive: true, force: true });
        removed.push(relative);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return removed;
  }

  #target(relative: string): string {
    const target = path.resolve(this.#stateDir, relative);
    const rel = path.relative(this.#stateDir, target);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new OperatorError('DEVICE_RESET_PATH_INVALID', 'Device reset target escaped the Operator state directory.');
    return target;
  }

  async #assertSafeTarget(target: string): Promise<void> {
    try {
      const stat = await fs.lstat(target);
      if (stat.isSymbolicLink()) throw new OperatorError('DEVICE_RESET_PATH_UNSAFE', 'Device reset refuses symbolic-link targets.');
      if (stat.isDirectory()) await assertTreeHasNoSymlinks(target, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
  async #readJournal(): Promise<LocalResetJournal | null> {
    try {
      const text = await readDurableStateText(this.#journalFile, {
        maxBytes: MAX_JOURNAL_BYTES,
        errorCode: 'DEVICE_RESET_LOCAL_STATE_INVALID',
        invalidMessage: 'Local device reset state is invalid.'
      });
      return validateJournal(JSON.parse(text));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      if (error instanceof OperatorError) throw error;
      throw new OperatorError('DEVICE_RESET_LOCAL_STATE_INVALID', 'Local device reset state could not be read.');
    }
  }

  async #writeJournal(journal: LocalResetJournal): Promise<void> {
    await writeDurableStateText(this.#journalFile, JSON.stringify(validateJournal(journal), null, 2), {
      maxBytes: MAX_JOURNAL_BYTES,
      errorCode: 'DEVICE_RESET_LOCAL_STATE_INVALID',
      invalidMessage: 'Local device reset state is invalid.'
    });
  }

  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.#queue;
    this.#queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }
}
function authorityTargets(): string[] {
  return [
    'relay-session-credential.json',
    'relay-session.token',
    'relay-client.json',
    'device-sessions.json',
    'device-registry.json',
    'device-routing.json',
    'approvals.json',
    'provider-learning.json',
    'relay-outbox'
  ];
}

function validateJournal(input: unknown): LocalResetJournal {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new OperatorError('DEVICE_RESET_LOCAL_STATE_INVALID', 'Local reset journal must be an object.');
  const raw = input as Record<string, unknown>;
  if (raw.version !== 1) throw new OperatorError('DEVICE_RESET_LOCAL_STATE_INVALID', 'Local reset journal version is invalid.');
  const deviceId = validUuid(String(raw.deviceId ?? ''), 'deviceId');
  const phase = raw.phase === 'HOSTED_REVOKED' || raw.phase === 'COMPLETE' ? raw.phase : null;
  if (!phase) throw new OperatorError('DEVICE_RESET_LOCAL_STATE_INVALID', 'Local reset journal phase is invalid.');
  const hostedStatus = raw.hostedStatus === 'revoked' || raw.hostedStatus === 'not-configured' ? raw.hostedStatus : null;
  if (!hostedStatus) throw new OperatorError('DEVICE_RESET_LOCAL_STATE_INVALID', 'Local reset hosted status is invalid.');
  const hostedCompletedAt = validIso(String(raw.hostedCompletedAt ?? ''), 'hostedCompletedAt');
  const updatedAt = validIso(String(raw.updatedAt ?? ''), 'updatedAt');
  return { version: 1, deviceId, phase, hostedStatus, hostedCompletedAt, updatedAt };
}

function validateResetUrl(input: string): string {
  let url: URL;
  try { url = new URL(input); }
  catch { throw new OperatorError('DEVICE_RESET_URL_INVALID', 'Hosted device reset URL is invalid.'); }
  if (url.username || url.password || url.hash || url.search || url.pathname !== '/v1/device-self/reset') {
    throw new OperatorError('DEVICE_RESET_URL_INVALID', 'Hosted device reset URL must use the fixed credential-free endpoint.');
  }
  if (url.protocol === 'https:') return url.toString();
  if (url.protocol === 'http:' && isLoopback(url.hostname)) return url.toString();
  throw new OperatorError('DEVICE_RESET_TLS_REQUIRED', 'Hosted device reset requires HTTPS except for loopback development.');
}

function validUuid(value: string, label: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new OperatorError('DEVICE_RESET_LOCAL_STATE_INVALID', `${label} must be a UUID.`);
  }
  return value.toLowerCase();
}
function validIso(value: string, label: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    throw new OperatorError('DEVICE_RESET_LOCAL_STATE_INVALID', `${label} must be an ISO timestamp.`);
  }
  return value;
}

function isLoopback(host: string): boolean {
  const value = host.replace(/^\[|\]$/g, '').toLowerCase();
  return value === '127.0.0.1' || value === '::1' || value === 'localhost';
}

async function assertTreeHasNoSymlinks(dir: string, seen: number): Promise<number> {
  let count = seen;
  for (const name of await fs.readdir(dir)) {
    count += 1;
    if (count > MAX_TREE_ENTRIES) throw new OperatorError('DEVICE_RESET_PATH_UNSAFE', 'Device reset tree exceeds the bounded entry count.');
    const child = path.join(dir, name);
    const stat = await fs.lstat(child);
    if (stat.isSymbolicLink()) throw new OperatorError('DEVICE_RESET_PATH_UNSAFE', 'Device reset refuses symbolic links inside authority state.');
    if (stat.isDirectory()) count = await assertTreeHasNoSymlinks(child, count);
  }
  return count;
}
