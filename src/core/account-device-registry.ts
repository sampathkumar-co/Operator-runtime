import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DeviceRegistryStore } from './device-registry.ts';
import { OperatorError } from './errors.ts';
import { readDurableStateText, writeDurableStateText } from './durable-state.ts';

const MAX_ACCOUNTS = 100_000;
const MAX_MEMBERSHIPS = 500_000;
export const MAX_ACTIVE_DEVICES_PER_ACCOUNT = 32;
export const MAX_KNOWN_DEVICES_PER_ACCOUNT = 128;
const MAX_AUTH_FIELD = 1024;
const ERASURE_TOMBSTONE_RETENTION_MS = 24 * 60 * 60_000;

type Clock = () => Date;
export type AccountErasurePhase = 'REQUESTED' | 'AUTHORITY_REVOKED' | 'LIVE_CONNECTIONS_CLOSED' | 'ROUTING_DISABLED' | 'DELIVERY_SESSION_RESULT_PURGE' | 'ACCOUNT_STORAGE_PURGE' | 'REGISTRY_REMOVED' | 'COMPLETE';
type ReleaseDeviceHook = (deviceId: string, accountId: string, reason: 'removed' | 'disabled' | 'erased' | 'rebind') => Promise<void> | void;
type ErasurePhaseHook = (phase: AccountErasurePhase, accountId: string, deviceIds: string[]) => Promise<void> | void;
type AfterErasurePhaseHook = (phase: AccountErasurePhase, accountId: string) => Promise<void> | void;

export interface AccountPrincipal {
  issuer: string;
  subject: string;
}

export interface OperatorAccount {
  accountId: string;
  principalHash: string;
  status: 'active' | 'disabled' | 'erasing';
  createdAt: string;
  disabledAt?: string;
  disabledReason?: string;
}

export interface AccountDeviceAuthority {
  accountId: string;
  deviceId: string;
  generation: number;
}

export interface AccountDeviceMembership {
  accountId: string;
  deviceId: string;
  status: 'active' | 'removed';
  addedAt: string;
  authorityGeneration: number;
  removedAt?: string;
  removedReason?: string;
  releasePendingReason?: 'removed' | 'disabled';
}

export interface AccountErasureRecord {
  erasureId: string;
  accountId: string;
  deviceIds: string[];
  phase: AccountErasurePhase;
  requestedAt: string;
  updatedAt: string;
  completedAt?: string;
}

interface AccountDeviceState {
  version: 2;
  accounts: OperatorAccount[];
  memberships: AccountDeviceMembership[];
  erasures: AccountErasureRecord[];
}
type LegacyAccountDeviceState = { version: 1; accounts: OperatorAccount[]; memberships: AccountDeviceMembership[] };

export class AccountDeviceRegistry {
  #file: string;
  #stateDir: string;
  #devices: DeviceRegistryStore;
  #clock: Clock;
  #onReleaseDevice?: ReleaseDeviceHook;
  #onErasurePhase?: ErasurePhaseHook;
  #afterErasurePhase?: AfterErasurePhaseHook;
  #queue: Promise<void> = Promise.resolve();

  constructor(stateDir: string, devices: DeviceRegistryStore, options: { clock?: Clock; onReleaseDevice?: ReleaseDeviceHook; onErasurePhase?: ErasurePhaseHook; afterErasurePhase?: AfterErasurePhaseHook } = {}) {
    this.#stateDir = path.resolve(stateDir);
    this.#file = path.join(this.#stateDir, 'account-devices.json');
    this.#devices = devices;
    this.#clock = options.clock ?? (() => new Date());
    this.#onReleaseDevice = options.onReleaseDevice;
    this.#onErasurePhase = options.onErasurePhase;
    this.#afterErasurePhase = options.afterErasurePhase;
  }

  async resolveOrCreateAccount(principalInput: AccountPrincipal): Promise<OperatorAccount> {
    const principalHash = hashPrincipal(principalInput);
    return await this.#mutate((state) => {
      const existing = state.accounts.find((account) => account.principalHash === principalHash);
      if (existing) {
        if (existing.status === 'erasing') throw new OperatorError('ACCOUNT_ERASING', 'Operator account erasure is in progress.');
        if (existing.status !== 'active') throw new OperatorError('ACCOUNT_DISABLED', 'Operator account is disabled.');
        return cloneAccount(existing);
      }
      if (state.accounts.length >= MAX_ACCOUNTS) throw new OperatorError('ACCOUNT_LIMIT', `At most ${MAX_ACCOUNTS} accounts may be stored.`);
      const account: OperatorAccount = {
        accountId: crypto.randomUUID(),
        principalHash,
        status: 'active',
        createdAt: this.#clock().toISOString()
      };
      state.accounts.push(account);
      return cloneAccount(account);
    });
  }

  async getAccount(principalInput: AccountPrincipal): Promise<OperatorAccount | null> {
    const principalHash = hashPrincipal(principalInput);
    const state = await this.#read();
    const account = state.accounts.find((candidate) => candidate.principalHash === principalHash);
    return account ? cloneAccount(account) : null;
  }

  async disableAccount(accountIdInput: string, reasonInput: string): Promise<OperatorAccount> {
    const accountId = validUuid(accountIdInput, 'accountId');
    const reason = boundedReason(reasonInput, 'account disable reason');
    return await this.#withQueue(async () => {
      const state = await this.#read();
      pruneCompletedErasures(state, this.#clock().getTime());
      const account = state.accounts.find((candidate) => candidate.accountId === accountId);
      if (!account) throw new OperatorError('ACCOUNT_NOT_FOUND', 'Operator account was not found.');
      if (account.status === 'erasing') throw new OperatorError('ACCOUNT_ERASING', 'Operator account erasure is in progress.');
      if (account.status !== 'disabled') {
        const at = this.#clock().toISOString();
        account.status = 'disabled'; account.disabledAt = at; account.disabledReason = reason;
        for (const membership of state.memberships.filter((m) => m.accountId === accountId && m.status === 'active')) {
          membership.status = 'removed'; membership.removedAt = at; membership.removedReason = 'account-disabled'; membership.releasePendingReason = 'disabled';
        }
        await this.#write(state);
      }
      await this.#drainPendingReleasesLocked(state, { accountId });
      return cloneAccount(account);
    });
  }

  async assertCanBindDevice(accountIdInput: string, deviceIdInput?: string): Promise<void> {
    const accountId = validUuid(accountIdInput, 'accountId');
    const deviceId = deviceIdInput === undefined ? undefined : validUuid(deviceIdInput, 'deviceId');
    const state = await this.#read();
    requireActiveAccount(state, accountId);
    if (deviceId && state.memberships.some((m) => m.accountId === accountId && m.deviceId === deviceId && m.status === 'active')) return;
    const accountMemberships = state.memberships.filter((m) => m.accountId === accountId);
    const activeCount = accountMemberships.filter((m) => m.status === 'active').length;
    if (activeCount >= MAX_ACTIVE_DEVICES_PER_ACCOUNT) {
      throw new OperatorError('ACCOUNT_DEVICE_QUOTA', `An account may have at most ${MAX_ACTIVE_DEVICES_PER_ACCOUNT} active devices.`);
    }
    const knownDeviceIds = new Set(accountMemberships.map((m) => m.deviceId));
    if (deviceId && !knownDeviceIds.has(deviceId) && knownDeviceIds.size >= MAX_KNOWN_DEVICES_PER_ACCOUNT) {
      throw new OperatorError('ACCOUNT_DEVICE_QUOTA', `An account may retain at most ${MAX_KNOWN_DEVICES_PER_ACCOUNT} distinct device identities.`);
    }
  }

  async bindDevice(accountIdInput: string, deviceIdInput: string): Promise<AccountDeviceMembership> {
    const accountId = validUuid(accountIdInput, 'accountId');
    const deviceId = validUuid(deviceIdInput, 'deviceId');
    const device = (await this.#devices.listDevices()).find((candidate) => candidate.deviceId === deviceId);
    if (!device) throw new OperatorError('DEVICE_NOT_FOUND', 'Cannot bind an unpaired device to an account.');
    if (device.status !== 'active') throw new OperatorError('DEVICE_REVOKED', 'Cannot bind a revoked device to an account.');
    return await this.#mutate(async (state) => {
      requireActiveAccount(state, accountId);
      const active = state.memberships.find((m) => m.deviceId === deviceId && m.status === 'active');
      if (active && active.accountId !== accountId) throw new OperatorError('DEVICE_ACCOUNT_CONFLICT', 'Device is already bound to a different active account.');
      if (active) return cloneMembership(active);
      const accountMemberships = state.memberships.filter((m) => m.accountId === accountId);
      const activeCount = accountMemberships.filter((m) => m.status === 'active').length;
      if (activeCount >= MAX_ACTIVE_DEVICES_PER_ACCOUNT) throw new OperatorError('ACCOUNT_DEVICE_QUOTA', `An account may have at most ${MAX_ACTIVE_DEVICES_PER_ACCOUNT} active devices.`);
      const knownDeviceIds = new Set(accountMemberships.map((m) => m.deviceId));
      if (!knownDeviceIds.has(deviceId) && knownDeviceIds.size >= MAX_KNOWN_DEVICES_PER_ACCOUNT) {
        throw new OperatorError('ACCOUNT_DEVICE_QUOTA', `An account may retain at most ${MAX_KNOWN_DEVICES_PER_ACCOUNT} distinct device identities.`);
      }
      if (state.memberships.some((m) => m.deviceId === deviceId && m.releasePendingReason)) {
        throw new OperatorError('DEVICE_RELEASE_PENDING', 'Device cleanup from its previous authority has not completed yet.');
      }
      const priorOwners = [...new Set(state.memberships.filter((m) => m.deviceId === deviceId && m.status === 'removed').map((m) => m.accountId))];
      for (const priorAccountId of priorOwners) await this.#releaseDevice(deviceId, priorAccountId, 'rebind');
      if (state.memberships.length >= MAX_MEMBERSHIPS) throw new OperatorError('ACCOUNT_DEVICE_LIMIT', `At most ${MAX_MEMBERSHIPS} account-device memberships may be stored.`);
      const authorityGeneration = Math.max(0, ...state.memberships.filter((m) => m.deviceId === deviceId).map((m) => m.authorityGeneration ?? 1)) + 1;
      const membership: AccountDeviceMembership = { accountId, deviceId, status: 'active', addedAt: this.#clock().toISOString(), authorityGeneration };
      state.memberships.push(membership);
      return cloneMembership(membership);
    });
  }

  async removeDevice(accountIdInput: string, deviceIdInput: string, reasonInput: string): Promise<AccountDeviceMembership> {
    const accountId = validUuid(accountIdInput, 'accountId');
    const deviceId = validUuid(deviceIdInput, 'deviceId');
    const reason = boundedReason(reasonInput, 'device removal reason');
    return await this.#withQueue(async () => {
      const state = await this.#read();
      pruneCompletedErasures(state, this.#clock().getTime());
      requireActiveAccount(state, accountId);
      let membership = state.memberships.find((m) => m.accountId === accountId && m.deviceId === deviceId && m.status === 'active');
      if (membership) {
        membership.status = 'removed'; membership.removedAt = this.#clock().toISOString(); membership.removedReason = reason; membership.releasePendingReason = 'removed';
        await this.#write(state);
      } else {
        membership = state.memberships.find((m) => m.accountId === accountId && m.deviceId === deviceId && m.status === 'removed' && m.releasePendingReason === 'removed');
        if (!membership) throw new OperatorError('ACCOUNT_DEVICE_NOT_FOUND', 'Active account-device membership was not found.');
      }
      await this.#drainPendingReleasesLocked(state, { accountId, deviceId });
      return cloneMembership(membership);
    });
  }

  async eraseAccount(accountIdInput: string): Promise<{ accountId: string; releasedDeviceIds: string[] }> {
    const accountId = validUuid(accountIdInput, 'accountId');
    const started = await this.#withQueue(async () => {
      const state = await this.#read();
      pruneCompletedErasures(state, this.#clock().getTime());
      const existing = state.erasures.find((entry) => entry.accountId === accountId && entry.phase !== 'COMPLETE');
      await this.#drainPendingReleasesLocked(state, { accountId });
      if (existing) return { journal: cloneErasure(existing), created: false };
      const account = state.accounts.find((candidate) => candidate.accountId === accountId);
      if (!account) throw new OperatorError('ACCOUNT_NOT_FOUND', 'Operator account was not found.');
      const now = this.#clock().toISOString();
      const deviceIds = [...new Set(state.memberships.filter((m) => m.accountId === accountId && m.status === 'active').map((m) => m.deviceId))].sort();
      account.status = 'erasing';
      const created: AccountErasureRecord = { erasureId: crypto.randomUUID(), accountId, deviceIds, phase: 'REQUESTED', requestedAt: now, updatedAt: now };
      state.erasures.push(created);
      await this.#write(state);
      return { journal: cloneErasure(created), created: true };
    });
    if (started.created) await this.#afterErasurePhase?.('REQUESTED', accountId);
    return await this.#resumeErasure(started.journal.erasureId);
  }

  async recoverReleases(): Promise<number> {
    return await this.#withQueue(async () => {
      const state = await this.#read();
      pruneCompletedErasures(state, this.#clock().getTime());
      return await this.#drainPendingReleasesLocked(state);
    });
  }

  async recoverErasures(): Promise<number> {
    await this.recoverReleases();
    const state = await this.#read();
    const pending = state.erasures.filter((entry) => entry.phase !== 'COMPLETE').map((entry) => entry.erasureId);
    for (const erasureId of pending) await this.#resumeErasure(erasureId);
    return pending.length;
  }

  async erasePrincipal(principalInput: AccountPrincipal): Promise<{ erased: boolean; accountId?: string; releasedDeviceIds: string[] }> {
    const account = await this.getAccount(principalInput);
    if (!account) return { erased: false, releasedDeviceIds: [] };
    const erased = await this.eraseAccount(account.accountId);
    return { erased: true, ...erased };
  }

  async listDevices(accountIdInput: string): Promise<AccountDeviceMembership[]> {
    const accountId = validUuid(accountIdInput, 'accountId');
    const state = await this.#read();
    requireActiveAccount(state, accountId);
    const cryptoDevices = new Map((await this.#devices.listDevices()).map((device) => [device.deviceId, device.status]));
    return state.memberships
      .filter((membership) => membership.accountId === accountId && membership.status === 'active' && cryptoDevices.get(membership.deviceId) === 'active')
      .map(cloneMembership);
  }

  async activeMembershipForDevice(deviceIdInput: string): Promise<AccountDeviceMembership | null> {
    const deviceId = validUuid(deviceIdInput, 'deviceId');
    const state = await this.#read();
    const membership = state.memberships.find((candidate) => candidate.deviceId === deviceId && candidate.status === 'active');
    if (!membership) return null;
    const account = state.accounts.find((candidate) => candidate.accountId === membership.accountId);
    if (!account || account.status !== 'active') return null;
    const device = (await this.#devices.listDevices()).find((candidate) => candidate.deviceId === deviceId);
    return device?.status === 'active' ? cloneMembership(membership) : null;
  }

  async ownsDevice(accountIdInput: string, deviceIdInput: string): Promise<boolean> {
    const accountId = validUuid(accountIdInput, 'accountId');
    const deviceId = validUuid(deviceIdInput, 'deviceId');
    const state = await this.#read();
    const account = state.accounts.find((candidate) => candidate.accountId === accountId);
    if (!account || account.status !== 'active') return false;
    const membership = state.memberships.find((candidate) => candidate.accountId === accountId && candidate.deviceId === deviceId && candidate.status === 'active');
    if (!membership) return false;
    const device = (await this.#devices.listDevices()).find((candidate) => candidate.deviceId === deviceId);
    return device?.status === 'active';
  }

  async withActiveAuthorityLease<T>(authorityInput: AccountDeviceAuthority, work: () => Promise<T>): Promise<T> {
    const accountId = validUuid(authorityInput?.accountId, 'authority accountId');
    const deviceId = validUuid(authorityInput?.deviceId, 'authority deviceId');
    const generation = Number(authorityInput?.generation);
    if (!Number.isSafeInteger(generation) || generation < 1) throw new OperatorError('ACCOUNT_AUTHORITY_INVALID', 'Account-device authority generation is invalid.');
    if (typeof work !== 'function') throw new OperatorError('ACCOUNT_AUTHORITY_INVALID', 'Account-device authority lease work is invalid.');
    return await this.#withQueue(async () => {
      const state = await this.#read();
      const account = state.accounts.find((candidate) => candidate.accountId === accountId);
      const membership = state.memberships.find((candidate) => candidate.accountId === accountId && candidate.deviceId === deviceId && candidate.status === 'active');
      if (!account || account.status !== 'active' || !membership || membership.authorityGeneration !== generation) {
        throw new OperatorError('ACCOUNT_AUTHORITY_REVOKED', 'Account-device authority is no longer active.');
      }
      const device = (await this.#devices.listDevices()).find((candidate) => candidate.deviceId === deviceId);
      if (!device || device.status !== 'active') throw new OperatorError('ACCOUNT_AUTHORITY_REVOKED', 'Device cryptographic authority is no longer active.');
      return await work();
    });
  }

  async #resumeErasure(erasureIdInput: string): Promise<{ accountId: string; releasedDeviceIds: string[] }> {
    const erasureId = validUuid(erasureIdInput, 'erasureId');
    while (true) {
      const state = await this.#read();
      const journal = state.erasures.find((entry) => entry.erasureId === erasureId);
      if (!journal) throw new OperatorError('ACCOUNT_ERASURE_NOT_FOUND', 'Account erasure journal was not found.');
      const accountId = journal.accountId;
      const deviceIds = [...journal.deviceIds];
      if (journal.phase === 'COMPLETE') return { accountId, releasedDeviceIds: deviceIds };

      if (journal.phase === 'REQUESTED') {
        await this.#advanceErasure(erasureId, 'REQUESTED', 'AUTHORITY_REVOKED');
        await this.#afterErasurePhase?.('AUTHORITY_REVOKED', accountId);
        continue;
      }
      if (journal.phase === 'AUTHORITY_REVOKED') {
        if (this.#onErasurePhase) await this.#onErasurePhase('LIVE_CONNECTIONS_CLOSED', accountId, deviceIds);
        else for (const deviceId of deviceIds) await this.#releaseDevice(deviceId, accountId, 'erased');
        await this.#advanceErasure(erasureId, 'AUTHORITY_REVOKED', 'LIVE_CONNECTIONS_CLOSED');
        await this.#afterErasurePhase?.('LIVE_CONNECTIONS_CLOSED', accountId);
        continue;
      }
      if (journal.phase === 'LIVE_CONNECTIONS_CLOSED') {
        await this.#onErasurePhase?.('ROUTING_DISABLED', accountId, deviceIds);
        await this.#advanceErasure(erasureId, 'LIVE_CONNECTIONS_CLOSED', 'ROUTING_DISABLED');
        await this.#afterErasurePhase?.('ROUTING_DISABLED', accountId);
        continue;
      }
      if (journal.phase === 'ROUTING_DISABLED') {
        await this.#onErasurePhase?.('DELIVERY_SESSION_RESULT_PURGE', accountId, deviceIds);
        await this.#advanceErasure(erasureId, 'ROUTING_DISABLED', 'DELIVERY_SESSION_RESULT_PURGE');
        await this.#afterErasurePhase?.('DELIVERY_SESSION_RESULT_PURGE', accountId);
        continue;
      }
      if (journal.phase === 'DELIVERY_SESSION_RESULT_PURGE') {
        const accountDir = await safeAccountEraseTarget(this.#stateDir, accountId);
        await fs.rm(accountDir, { recursive: true, force: true });
        await this.#advanceErasure(erasureId, 'DELIVERY_SESSION_RESULT_PURGE', 'ACCOUNT_STORAGE_PURGE');
        await this.#afterErasurePhase?.('ACCOUNT_STORAGE_PURGE', accountId);
        continue;
      }
      if (journal.phase === 'ACCOUNT_STORAGE_PURGE') {
        await this.#withQueue(async () => {
          const current = await this.#read();
          const entry = requireErasure(current, erasureId, 'ACCOUNT_STORAGE_PURGE');
          const ownedHistory = [...new Set(current.memberships.filter((membership) => membership.accountId === accountId).map((membership) => membership.deviceId))];
          for (const deviceId of ownedHistory) {
            const activeElsewhere = current.memberships.some((membership) => membership.deviceId === deviceId && membership.accountId !== accountId && membership.status === 'active');
            if (!activeElsewhere) await this.#devices.unregisterActiveDevice(deviceId);
          }
          current.memberships = current.memberships.filter((membership) => membership.accountId !== accountId);
          current.accounts = current.accounts.filter((candidate) => candidate.accountId !== accountId);
          entry.phase = 'REGISTRY_REMOVED'; entry.updatedAt = this.#clock().toISOString();
          await this.#write(current);
        });
        await this.#afterErasurePhase?.('REGISTRY_REMOVED', accountId);
        continue;
      }
      if (journal.phase === 'REGISTRY_REMOVED') {
        await this.#mutate((current) => {
          const entry = requireErasure(current, erasureId, 'REGISTRY_REMOVED');
          const now = this.#clock().toISOString();
          entry.phase = 'COMPLETE'; entry.updatedAt = now; entry.completedAt = now;
        });
        await this.#afterErasurePhase?.('COMPLETE', accountId);
        continue;
      }
      throw new OperatorError('ACCOUNT_ERASURE_STATE_CORRUPT', 'Account erasure journal phase is invalid.');
    }
  }

  async #advanceErasure(erasureId: string, expected: AccountErasurePhase, next: AccountErasurePhase): Promise<void> {
    await this.#mutate((state) => {
      const entry = requireErasure(state, erasureId, expected);
      entry.phase = next;
      entry.updatedAt = this.#clock().toISOString();
    });
  }
  async #drainPendingReleasesLocked(state: AccountDeviceState, filter: { accountId?: string; deviceId?: string } = {}): Promise<number> {
    const pending = state.memberships
      .filter((membership) => membership.status === 'removed' && membership.releasePendingReason
        && (!filter.accountId || membership.accountId === filter.accountId)
        && (!filter.deviceId || membership.deviceId === filter.deviceId))
      .sort((a, b) => a.deviceId.localeCompare(b.deviceId) || a.authorityGeneration - b.authorityGeneration);
    let completed = 0;
    for (const target of pending) {
      const reason = target.releasePendingReason!;
      await this.#releaseDevice(target.deviceId, target.accountId, reason);
      const current = state.memberships.find((membership) => membership.accountId === target.accountId && membership.deviceId === target.deviceId && membership.authorityGeneration === target.authorityGeneration);
      if (current?.releasePendingReason === reason) {
        current.releasePendingReason = undefined;
        await this.#write(state);
      }
      completed += 1;
    }
    return completed;
  }

  async #releaseDevice(deviceId: string, accountId: string, reason: 'removed' | 'disabled' | 'erased' | 'rebind'): Promise<void> {
    await this.#onReleaseDevice?.(deviceId, accountId, reason);
  }

  async #read(): Promise<AccountDeviceState> {
    try {
      const text = await readDurableStateText(this.#file, {
        maxBytes: 32 * 1024 * 1024,
        errorCode: 'ACCOUNT_STATE_CORRUPT',
        invalidMessage: 'Account-device registry is invalid.'
      });
      const parsed = JSON.parse(text) as AccountDeviceState | LegacyAccountDeviceState;
      if (parsed?.version === 1) return validateState({ version: 2, accounts: parsed.accounts, memberships: parsed.memberships, erasures: [] });
      return validateState(parsed as AccountDeviceState);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 2, accounts: [], memberships: [], erasures: [] };
      if (error instanceof OperatorError) throw error;
      throw new OperatorError('ACCOUNT_STATE_CORRUPT', 'Account-device registry could not be read.');
    }
  }

  async #write(stateInput: AccountDeviceState): Promise<void> {
    const state = validateState(stateInput);
    await writeDurableStateText(this.#file, JSON.stringify(state, null, 2), {
      maxBytes: 32 * 1024 * 1024,
      errorCode: 'ACCOUNT_STATE_CORRUPT',
      invalidMessage: 'Account-device registry is invalid.'
    });
  }

  async #mutate<T>(mutator: (state: AccountDeviceState) => T | Promise<T>): Promise<T> {
    return await this.#withQueue(async () => {
      const state = await this.#read();
      pruneCompletedErasures(state, this.#clock().getTime());
      const result = await mutator(state);
      await this.#write(state);
      return result;
    });
  }

  async #withQueue<T>(work: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.#queue;
    this.#queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await work(); }
    finally { release(); }
  }
}

export function hashPrincipal(principalInput: AccountPrincipal): string {
  if (!principalInput || typeof principalInput !== 'object') throw new OperatorError('ACCOUNT_PRINCIPAL_INVALID', 'Account principal is invalid.');
  const issuer = boundedAuthField(principalInput.issuer, 'issuer');
  const subject = boundedAuthField(principalInput.subject, 'subject');
  return crypto.createHash('sha256').update(JSON.stringify({ issuer, subject }), 'utf8').digest('base64url');
}

function requireActiveAccount(state: AccountDeviceState, accountId: string): OperatorAccount {
  const account = state.accounts.find((candidate) => candidate.accountId === accountId);
  if (!account) throw new OperatorError('ACCOUNT_NOT_FOUND', 'Operator account was not found.');
  if (account.status === 'erasing') throw new OperatorError('ACCOUNT_ERASING', 'Operator account erasure is in progress.');
  if (account.status !== 'active') throw new OperatorError('ACCOUNT_DISABLED', 'Operator account is disabled.');
  return account;
}

function validateState(input: AccountDeviceState): AccountDeviceState {
  if (!input || typeof input !== 'object' || input.version !== 2 || !Array.isArray(input.accounts) || !Array.isArray(input.memberships) || !Array.isArray(input.erasures) || input.accounts.length > MAX_ACCOUNTS || input.memberships.length > MAX_MEMBERSHIPS || input.erasures.length > MAX_ACCOUNTS) {
    throw new OperatorError('ACCOUNT_STATE_CORRUPT', 'Account-device registry structure is invalid.');
  }
  const accountIds = new Set<string>();
  const principalHashes = new Set<string>();
  const accounts = input.accounts.map((raw) => {
    const accountId = validUuid(raw.accountId, 'accountId');
    const principalHash = String(raw.principalHash ?? '');
    if (!/^[A-Za-z0-9_-]{43,64}$/.test(principalHash)) throw new OperatorError('ACCOUNT_STATE_CORRUPT', 'Account principal hash is invalid.');
    if (accountIds.has(accountId) || principalHashes.has(principalHash)) throw new OperatorError('ACCOUNT_STATE_CORRUPT', 'Account registry contains duplicate identity bindings.');
    accountIds.add(accountId); principalHashes.add(principalHash);
    const status = raw.status === 'active' ? 'active' : raw.status === 'disabled' ? 'disabled' : raw.status === 'erasing' ? 'erasing' : null;
    if (!status) throw new OperatorError('ACCOUNT_STATE_CORRUPT', 'Account status is invalid.');
    const createdAt = validIso(raw.createdAt, 'createdAt');
    const disabledAt = raw.disabledAt === undefined ? undefined : validIso(raw.disabledAt, 'disabledAt');
    const disabledReason = raw.disabledReason === undefined ? undefined : boundedReason(raw.disabledReason, 'disabledReason');
    if (status === 'active' && (disabledAt || disabledReason)) throw new OperatorError('ACCOUNT_STATE_CORRUPT', 'Active account cannot contain disable metadata.');
    return { accountId, principalHash, status, createdAt, disabledAt, disabledReason } satisfies OperatorAccount;
  });

  const activeDevices = new Set<string>();
  const membershipKeys = new Set<string>();
  const memberships = input.memberships.map((raw) => {
    const accountId = validUuid(raw.accountId, 'membership accountId');
    if (!accountIds.has(accountId)) throw new OperatorError('ACCOUNT_STATE_CORRUPT', 'Membership references an unknown account.');
    const deviceId = validUuid(raw.deviceId, 'membership deviceId');
    const key = `${accountId}:${deviceId}:${raw.addedAt}`;
    if (membershipKeys.has(key)) throw new OperatorError('ACCOUNT_STATE_CORRUPT', 'Duplicate account-device membership record.');
    membershipKeys.add(key);
    const status = raw.status === 'active' ? 'active' : raw.status === 'removed' ? 'removed' : null;
    if (!status) throw new OperatorError('ACCOUNT_STATE_CORRUPT', 'Membership status is invalid.');
    const addedAt = validIso(raw.addedAt, 'addedAt');
    const authorityGeneration = raw.authorityGeneration === undefined ? 1 : Number(raw.authorityGeneration);
    if (!Number.isSafeInteger(authorityGeneration) || authorityGeneration < 1) throw new OperatorError('ACCOUNT_STATE_CORRUPT', 'Membership authority generation is invalid.');
    const removedAt = raw.removedAt === undefined ? undefined : validIso(raw.removedAt, 'removedAt');
    const removedReason = raw.removedReason === undefined ? undefined : boundedReason(raw.removedReason, 'removedReason');
    const releasePendingReason = raw.releasePendingReason === undefined ? undefined
      : raw.releasePendingReason === 'removed' || raw.releasePendingReason === 'disabled' ? raw.releasePendingReason : null;
    if (releasePendingReason === null) throw new OperatorError('ACCOUNT_STATE_CORRUPT', 'Membership pending release reason is invalid.');
    if (status === 'active') {
      if (removedAt || removedReason || releasePendingReason) throw new OperatorError('ACCOUNT_STATE_CORRUPT', 'Active membership cannot contain removal metadata.');
      if (activeDevices.has(deviceId)) throw new OperatorError('ACCOUNT_STATE_CORRUPT', 'One device cannot have multiple active account memberships.');
      activeDevices.add(deviceId);
    } else if (releasePendingReason && (!removedAt || !removedReason)) {
      throw new OperatorError('ACCOUNT_STATE_CORRUPT', 'Pending release cleanup requires removal metadata.');
    }
    return { accountId, deviceId, status, addedAt, authorityGeneration, removedAt, removedReason, releasePendingReason: releasePendingReason ?? undefined } satisfies AccountDeviceMembership;
  });

  const erasureIds = new Set<string>();
  const erasureAccounts = new Set<string>();
  const phases = new Set<AccountErasurePhase>(['REQUESTED', 'AUTHORITY_REVOKED', 'LIVE_CONNECTIONS_CLOSED', 'ROUTING_DISABLED', 'DELIVERY_SESSION_RESULT_PURGE', 'ACCOUNT_STORAGE_PURGE', 'REGISTRY_REMOVED', 'COMPLETE']);
  const erasures = input.erasures.map((raw) => {
    const erasureId = validUuid(raw.erasureId, 'erasureId');
    const accountId = validUuid(raw.accountId, 'erasure accountId');
    if (erasureIds.has(erasureId) || erasureAccounts.has(accountId)) throw new OperatorError('ACCOUNT_STATE_CORRUPT', 'Account erasure journal contains duplicate identifiers.');
    erasureIds.add(erasureId); erasureAccounts.add(accountId);
    if (!phases.has(raw.phase)) throw new OperatorError('ACCOUNT_STATE_CORRUPT', 'Account erasure phase is invalid.');
    if (!Array.isArray(raw.deviceIds) || raw.deviceIds.length > MAX_MEMBERSHIPS) throw new OperatorError('ACCOUNT_STATE_CORRUPT', 'Account erasure device list is invalid.');
    const deviceIds = raw.deviceIds.map((deviceId) => validUuid(deviceId, 'erasure deviceId')).sort();
    if (new Set(deviceIds).size !== deviceIds.length) throw new OperatorError('ACCOUNT_STATE_CORRUPT', 'Account erasure device list contains duplicates.');
    const requestedAt = validIso(raw.requestedAt, 'erasure requestedAt');
    const updatedAt = validIso(raw.updatedAt, 'erasure updatedAt');
    const completedAt = raw.completedAt === undefined ? undefined : validIso(raw.completedAt, 'erasure completedAt');
    if (raw.phase === 'COMPLETE' ? !completedAt : Boolean(completedAt)) throw new OperatorError('ACCOUNT_STATE_CORRUPT', 'Account erasure completion metadata is inconsistent.');
    if (!['REGISTRY_REMOVED', 'COMPLETE'].includes(raw.phase)) {
      const account = accounts.find((candidate) => candidate.accountId === accountId);
      if (!account || account.status !== 'erasing') throw new OperatorError('ACCOUNT_STATE_CORRUPT', 'In-progress erasure must retain an erasing account tombstone.');
    }
    return { erasureId, accountId, deviceIds, phase: raw.phase, requestedAt, updatedAt, completedAt } satisfies AccountErasureRecord;
  });
  for (const account of accounts.filter((candidate) => candidate.status === 'erasing')) {
    const journal = erasures.find((entry) => entry.accountId === account.accountId && !['REGISTRY_REMOVED', 'COMPLETE'].includes(entry.phase));
    if (!journal) throw new OperatorError('ACCOUNT_STATE_CORRUPT', 'Erasing account is missing its resumable erasure journal.');
  }
  return { version: 2, accounts, memberships, erasures };
}

function requireErasure(state: AccountDeviceState, erasureId: string, expected: AccountErasurePhase): AccountErasureRecord {
  const entry = state.erasures.find((candidate) => candidate.erasureId === erasureId);
  if (!entry) throw new OperatorError('ACCOUNT_ERASURE_NOT_FOUND', 'Account erasure journal was not found.');
  if (entry.phase !== expected) throw new OperatorError('ACCOUNT_ERASURE_PHASE_CHANGED', 'Account erasure phase changed during recovery.');
  return entry;
}

function cloneErasure(entry: AccountErasureRecord): AccountErasureRecord { return { ...entry, deviceIds: [...entry.deviceIds] }; }
function pruneCompletedErasures(state: AccountDeviceState, now: number): void {
  state.erasures = state.erasures.filter((entry) => entry.phase !== 'COMPLETE' || !entry.completedAt || Date.parse(entry.completedAt) > now - ERASURE_TOMBSTONE_RETENTION_MS);
}
function cloneAccount(account: OperatorAccount): OperatorAccount { return { ...account }; }
function cloneMembership(membership: AccountDeviceMembership): AccountDeviceMembership { return { ...membership }; }

function boundedAuthField(value: string, label: string): string {
  const text = String(value ?? '').trim();
  if (!text || text.length > MAX_AUTH_FIELD || /[\0\r\n]/.test(text)) throw new OperatorError('ACCOUNT_PRINCIPAL_INVALID', `Account ${label} is invalid.`);
  return text;
}

function boundedReason(value: string, label: string): string {
  const text = String(value ?? '').trim();
  if (!text || text.length > 512 || /\0/.test(text)) throw new OperatorError('ACCOUNT_REASON_INVALID', `${label} is invalid.`);
  return text;
}

function validUuid(value: string, label: string): string {
  const text = String(value ?? '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) throw new OperatorError('ACCOUNT_ID_INVALID', `${label} must be a UUID.`);
  return text.toLowerCase();
}

function validIso(value: string, label: string): string {
  const text = String(value ?? '');
  const time = Date.parse(text);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== text) throw new OperatorError('ACCOUNT_STATE_CORRUPT', `${label} must be an ISO timestamp.`);
  return text;
}

async function safeAccountEraseTarget(stateDir: string, accountId: string): Promise<string> {
  const root = path.resolve(stateDir);
  const accountsDir = path.join(root, 'accounts');
  const target = path.join(accountsDir, accountId);
  for (const [candidate, label] of [[root, 'state root'], [accountsDir, 'accounts directory'], [target, 'account directory']] as const) {
    try {
      const stat = await fs.lstat(candidate);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new OperatorError('ACCOUNT_ERASURE_PATH_INVALID', `Refusing account erasure through an unsafe ${label}.`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && candidate !== root) continue;
      throw error;
    }
  }
  return target;
}
