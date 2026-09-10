import crypto from 'node:crypto';
import path from 'node:path';
import { DeviceRegistryStore } from './device-registry.ts';
import { OperatorError } from './errors.ts';
import { readDurableStateText, writeDurableStateText } from './durable-state.ts';

const MAX_ACCOUNTS = 100_000;
const MAX_MEMBERSHIPS = 500_000;
const MAX_AUTH_FIELD = 1024;

type Clock = () => Date;

export interface AccountPrincipal {
  issuer: string;
  subject: string;
}

export interface OperatorAccount {
  accountId: string;
  principalHash: string;
  status: 'active' | 'disabled';
  createdAt: string;
  disabledAt?: string;
  disabledReason?: string;
}

export interface AccountDeviceMembership {
  accountId: string;
  deviceId: string;
  status: 'active' | 'removed';
  addedAt: string;
  removedAt?: string;
  removedReason?: string;
}

interface AccountDeviceState {
  version: 1;
  accounts: OperatorAccount[];
  memberships: AccountDeviceMembership[];
}

export class AccountDeviceRegistry {
  #file: string;
  #devices: DeviceRegistryStore;
  #clock: Clock;
  #queue: Promise<void> = Promise.resolve();

  constructor(stateDir: string, devices: DeviceRegistryStore, options: { clock?: Clock } = {}) {
    this.#file = path.join(path.resolve(stateDir), 'account-devices.json');
    this.#devices = devices;
    this.#clock = options.clock ?? (() => new Date());
  }

  async resolveOrCreateAccount(principalInput: AccountPrincipal): Promise<OperatorAccount> {
    const principalHash = hashPrincipal(principalInput);
    return await this.#mutate((state) => {
      const existing = state.accounts.find((account) => account.principalHash === principalHash);
      if (existing) {
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
    return await this.#mutate((state) => {
      const account = state.accounts.find((candidate) => candidate.accountId === accountId);
      if (!account) throw new OperatorError('ACCOUNT_NOT_FOUND', 'Operator account was not found.');
      if (account.status === 'disabled') return cloneAccount(account);
      const at = this.#clock().toISOString();
      account.status = 'disabled';
      account.disabledAt = at;
      account.disabledReason = reason;
      for (const membership of state.memberships) {
        if (membership.accountId === accountId && membership.status === 'active') {
          membership.status = 'removed';
          membership.removedAt = at;
          membership.removedReason = 'account-disabled';
        }
      }
      return cloneAccount(account);
    });
  }

  async bindDevice(accountIdInput: string, deviceIdInput: string): Promise<AccountDeviceMembership> {
    const accountId = validUuid(accountIdInput, 'accountId');
    const deviceId = validUuid(deviceIdInput, 'deviceId');
    const device = (await this.#devices.listDevices()).find((candidate) => candidate.deviceId === deviceId);
    if (!device) throw new OperatorError('DEVICE_NOT_FOUND', 'Cannot bind an unpaired device to an account.');
    if (device.status !== 'active') throw new OperatorError('DEVICE_REVOKED', 'Cannot bind a revoked device to an account.');

    return await this.#mutate((state) => {
      const account = requireActiveAccount(state, accountId);
      void account;
      const activeForDevice = state.memberships.find((membership) => membership.deviceId === deviceId && membership.status === 'active');
      if (activeForDevice && activeForDevice.accountId !== accountId) {
        throw new OperatorError('DEVICE_ACCOUNT_CONFLICT', 'Device is already bound to a different active account.');
      }
      if (activeForDevice) return cloneMembership(activeForDevice);
      if (state.memberships.length >= MAX_MEMBERSHIPS) throw new OperatorError('ACCOUNT_DEVICE_LIMIT', `At most ${MAX_MEMBERSHIPS} account-device memberships may be stored.`);
      const membership: AccountDeviceMembership = {
        accountId,
        deviceId,
        status: 'active',
        addedAt: this.#clock().toISOString()
      };
      state.memberships.push(membership);
      return cloneMembership(membership);
    });
  }

  async removeDevice(accountIdInput: string, deviceIdInput: string, reasonInput: string): Promise<AccountDeviceMembership> {
    const accountId = validUuid(accountIdInput, 'accountId');
    const deviceId = validUuid(deviceIdInput, 'deviceId');
    const reason = boundedReason(reasonInput, 'device removal reason');
    return await this.#mutate((state) => {
      requireActiveAccount(state, accountId);
      const membership = state.memberships.find((candidate) => candidate.accountId === accountId && candidate.deviceId === deviceId && candidate.status === 'active');
      if (!membership) throw new OperatorError('ACCOUNT_DEVICE_NOT_FOUND', 'Active account-device membership was not found.');
      membership.status = 'removed';
      membership.removedAt = this.#clock().toISOString();
      membership.removedReason = reason;
      return cloneMembership(membership);
    });
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

  async #read(): Promise<AccountDeviceState> {
    try {
      const text = await readDurableStateText(this.#file, {
        maxBytes: 32 * 1024 * 1024,
        errorCode: 'ACCOUNT_STATE_CORRUPT',
        invalidMessage: 'Account-device registry is invalid.'
      });
      return validateState(JSON.parse(text));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, accounts: [], memberships: [] };
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
    let release!: () => void;
    const previous = this.#queue;
    this.#queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const state = await this.#read();
      const result = await mutator(state);
      await this.#write(state);
      return result;
    } finally {
      release();
    }
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
  if (account.status !== 'active') throw new OperatorError('ACCOUNT_DISABLED', 'Operator account is disabled.');
  return account;
}

function validateState(input: AccountDeviceState): AccountDeviceState {
  if (!input || typeof input !== 'object' || input.version !== 1 || !Array.isArray(input.accounts) || !Array.isArray(input.memberships) || input.accounts.length > MAX_ACCOUNTS || input.memberships.length > MAX_MEMBERSHIPS) {
    throw new OperatorError('ACCOUNT_STATE_CORRUPT', 'Account-device registry structure is invalid.');
  }
  const accountIds = new Set<string>();
  const principalHashes = new Set<string>();
  const accounts = input.accounts.map((raw) => {
    const accountId = validUuid(raw.accountId, 'accountId');
    const principalHash = String(raw.principalHash ?? '');
    if (!/^[A-Za-z0-9_-]{43,64}$/.test(principalHash)) throw new OperatorError('ACCOUNT_STATE_CORRUPT', 'Account principal hash is invalid.');
    if (accountIds.has(accountId) || principalHashes.has(principalHash)) throw new OperatorError('ACCOUNT_STATE_CORRUPT', 'Account registry contains duplicate identity bindings.');
    accountIds.add(accountId);
    principalHashes.add(principalHash);
    const status = raw.status === 'active' ? 'active' : raw.status === 'disabled' ? 'disabled' : null;
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
    const removedAt = raw.removedAt === undefined ? undefined : validIso(raw.removedAt, 'removedAt');
    const removedReason = raw.removedReason === undefined ? undefined : boundedReason(raw.removedReason, 'removedReason');
    if (status === 'active') {
      if (removedAt || removedReason) throw new OperatorError('ACCOUNT_STATE_CORRUPT', 'Active membership cannot contain removal metadata.');
      if (activeDevices.has(deviceId)) throw new OperatorError('ACCOUNT_STATE_CORRUPT', 'One device cannot have multiple active account memberships.');
      activeDevices.add(deviceId);
    }
    return { accountId, deviceId, status, addedAt, removedAt, removedReason } satisfies AccountDeviceMembership;
  });
  return { version: 1, accounts, memberships };
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
