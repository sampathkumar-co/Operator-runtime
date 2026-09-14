import crypto from 'node:crypto';
import path from 'node:path';
import type { PublicDeviceIdentity } from './device-identity.ts';
import { OperatorError } from './errors.ts';
import { readDurableStateText, writeDurableStateText } from './durable-state.ts';

const VERSION = 1 as const;
const MAX_RECORDS = 2048;
const DEFAULT_TTL_MS = 10 * 60_000;
const MIN_TTL_MS = 60_000;
const MAX_TTL_MS = 15 * 60_000;
const RETENTION_MS = 24 * 60 * 60_000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

type EnrollmentStatus = 'pending' | 'reserved' | 'claimed' | 'issued';

export interface DeviceEnrollmentRecord {
  enrollmentId: string;
  deviceId: string;
  deviceName: string;
  fingerprint: string;
  status: EnrollmentStatus;
  createdAt: string;
  expiresAt: string;
  accountId?: string;
  authorityGeneration?: number;
  reservedAt?: string;
  claimedAt?: string;
  sessionJti?: string;
  issuedAt?: string;
}
type StoredEnrollment = DeviceEnrollmentRecord & {
  userCodeSha256: string;
  pollTokenSha256: string;
  peerCreatedAt?: string;
  peerPublicKeyPem?: string;
};
type EnrollmentState = { version: typeof VERSION; enrollments: StoredEnrollment[] };

export interface NewDeviceEnrollment {
  enrollmentId: string;
  deviceId: string;
  deviceName: string;
  fingerprint: string;
  userCode: string;
  pollToken: string;
  expiresAt: string;
}

export class DeviceEnrollmentStore {
  #file: string;
  #clock: () => Date;
  #queue: Promise<void> = Promise.resolve();

  constructor(stateDir: string, options: { clock?: () => Date } = {}) {
    this.#file = path.join(path.resolve(stateDir), 'device-enrollments.json');
    this.#clock = options.clock ?? (() => new Date());
  }
  async create(deviceInput: PublicDeviceIdentity, options: { enrollmentId?: string; pollToken?: string; ttlMs?: number } = {}): Promise<NewDeviceEnrollment> {
    const device = normalizePeer(deviceInput);
    const ttl = boundedTtl(options.ttlMs ?? DEFAULT_TTL_MS);
    const now = this.#clock();
    const enrollmentId = options.enrollmentId === undefined ? crypto.randomUUID() : validUuid(options.enrollmentId, 'enrollmentId');
    const pollToken = options.pollToken === undefined ? crypto.randomBytes(32).toString('base64url') : boundedPollToken(options.pollToken);
    const userCode = userCodeFor(enrollmentId, pollToken);
    const pollTokenSha256 = secretHash('poll', pollToken);
    const userCodeSha256 = secretHash('code', normalizeUserCode(userCode));
    const base = {
      enrollmentId,
      deviceId: device.deviceId,
      deviceName: device.deviceName,
      fingerprint: device.fingerprint,
      peerCreatedAt: device.createdAt,
      peerPublicKeyPem: device.publicKeyPem
    };
    const stored = await this.#mutate((state) => {
      prune(state, now.getTime());
      const existing = state.enrollments.find((item) => item.enrollmentId === enrollmentId);
      if (existing) {
        if (existing.deviceId !== base.deviceId || existing.fingerprint !== base.fingerprint || existing.peerCreatedAt !== base.peerCreatedAt || existing.peerPublicKeyPem !== base.peerPublicKeyPem || !hashEquals(existing.pollTokenSha256, pollTokenSha256) || !hashEquals(existing.userCodeSha256, userCodeSha256)) {
          throw new OperatorError('DEVICE_ENROLLMENT_STATE_MISMATCH', 'Enrollment retry does not match the original device authority.');
        }
        return existing;
      }
      state.enrollments = state.enrollments.filter((item) => item.deviceId !== base.deviceId || item.status === 'issued');
      if (state.enrollments.length >= MAX_RECORDS) throw new OperatorError('DEVICE_ENROLLMENT_LIMIT', 'Device enrollment retention limit reached.');
      if (state.enrollments.some((item) => hashEquals(item.userCodeSha256, userCodeSha256))) throw new OperatorError('DEVICE_ENROLLMENT_CODE_COLLISION', 'Device enrollment code collision; begin a fresh pairing challenge.');
      const record: StoredEnrollment = { ...base, status: 'pending', createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + ttl).toISOString(), userCodeSha256, pollTokenSha256 };
      state.enrollments.push(record);
      return record;
    });
    return { enrollmentId, deviceId: stored.deviceId, deviceName: stored.deviceName, fingerprint: stored.fingerprint, userCode, pollToken, expiresAt: stored.expiresAt };
  }


  async pendingForCode(codeInput: string): Promise<DeviceEnrollmentRecord> {
    const codeHash = secretHash('code', normalizeUserCode(codeInput));
    const state = await this.#read();
    const now = this.#clock().getTime();
    const found = state.enrollments.find((item) => item.status === 'pending' && Date.parse(item.expiresAt) > now && hashEquals(item.userCodeSha256, codeHash));
    if (!found) throw new OperatorError('DEVICE_ENROLLMENT_CODE_INVALID', 'Device enrollment code is invalid or expired.');
    return publicRecord(found);
  }
  async reserve(codeInput: string, accountIdInput: string): Promise<DeviceEnrollmentRecord> {
    const codeHash = secretHash('code', normalizeUserCode(codeInput));
    const accountId = validUuid(accountIdInput, 'accountId');
    return await this.#mutate((state) => {
      prune(state, this.#clock().getTime());
      const item = state.enrollments.find((candidate) => hashEquals(candidate.userCodeSha256, codeHash));
      if (!item) throw new OperatorError('DEVICE_ENROLLMENT_CODE_INVALID', 'Device enrollment code is invalid or expired.');
      if (item.accountId && item.accountId !== accountId) throw new OperatorError('DEVICE_ENROLLMENT_ACCOUNT_CONFLICT', 'Device enrollment is already reserved by another account.');
      if (item.status === 'pending' && Date.parse(item.expiresAt) <= this.#clock().getTime()) throw new OperatorError('DEVICE_ENROLLMENT_CODE_INVALID', 'Device enrollment code is invalid or expired.');
      if (item.status === 'pending') {
        item.status = 'reserved';
        item.accountId = accountId;
        item.reservedAt = this.#clock().toISOString();
      }
      return publicRecord(item);
    });
  }

  async peerForClaim(enrollmentIdInput: string, accountIdInput: string): Promise<PublicDeviceIdentity> {
    const enrollmentId = validUuid(enrollmentIdInput, 'enrollmentId');
    const accountId = validUuid(accountIdInput, 'accountId');
    const state = await this.#read();
    const item = state.enrollments.find((candidate) => candidate.enrollmentId === enrollmentId);
    if (!item || item.accountId !== accountId || item.status === 'pending') throw new OperatorError('DEVICE_ENROLLMENT_STATE_MISMATCH', 'Device enrollment is not reserved for this account.');
    if (!item.peerCreatedAt || !item.peerPublicKeyPem) throw new OperatorError('DEVICE_ENROLLMENT_RESTART_REQUIRED', 'Legacy provisional enrollment lacks promotion authority; begin enrollment again.');
    return normalizePeer({ deviceId: item.deviceId, deviceName: item.deviceName, createdAt: item.peerCreatedAt, publicKeyPem: item.peerPublicKeyPem, fingerprint: item.fingerprint });
  }

  async markBound(enrollmentIdInput: string, accountIdInput: string, authorityGenerationInput: number): Promise<DeviceEnrollmentRecord> {
    const enrollmentId = validUuid(enrollmentIdInput, 'enrollmentId');
    const accountId = validUuid(accountIdInput, 'accountId');
    const authorityGeneration = validGeneration(authorityGenerationInput);
    return await this.#mutate((state) => {
      const item = state.enrollments.find((candidate) => candidate.enrollmentId === enrollmentId);
      if (!item || item.accountId !== accountId) throw new OperatorError('DEVICE_ENROLLMENT_STATE_MISMATCH', 'Device enrollment account reservation changed.');
      if (item.status === 'pending') throw new OperatorError('DEVICE_ENROLLMENT_NOT_RESERVED', 'Device enrollment has not been reserved by an account.');
      if (item.status === 'reserved') {
        item.status = 'claimed';
        item.authorityGeneration = authorityGeneration;
        item.claimedAt = this.#clock().toISOString();
      } else if (item.authorityGeneration !== authorityGeneration) {
        throw new OperatorError('DEVICE_ENROLLMENT_STATE_MISMATCH', 'Device enrollment authority generation changed.');
      }
      return publicRecord(item);
    });
  }

  async poll(enrollmentIdInput: string, pollTokenInput: string): Promise<DeviceEnrollmentRecord> {
    const enrollmentId = validUuid(enrollmentIdInput, 'enrollmentId');
    const pollHash = secretHash('poll', boundedPollToken(pollTokenInput));
    const state = await this.#read();
    const item = state.enrollments.find((candidate) => candidate.enrollmentId === enrollmentId);
    if (!item || !hashEquals(item.pollTokenSha256, pollHash)) throw new OperatorError('DEVICE_ENROLLMENT_UNAUTHORIZED', 'Device enrollment poll authority is invalid.');
    if (item.status === 'pending' && Date.parse(item.expiresAt) <= this.#clock().getTime()) throw new OperatorError('DEVICE_ENROLLMENT_EXPIRED', 'Device enrollment has expired.');
    return publicRecord(item);
  }

  async markIssued(enrollmentIdInput: string, pollTokenInput: string, sessionJtiInput: string): Promise<DeviceEnrollmentRecord> {
    const enrollmentId = validUuid(enrollmentIdInput, 'enrollmentId');
    const pollHash = secretHash('poll', boundedPollToken(pollTokenInput));
    const sessionJti = validUuid(sessionJtiInput, 'sessionJti');
    return await this.#mutate((state) => {
      const item = state.enrollments.find((candidate) => candidate.enrollmentId === enrollmentId);
      if (!item || !hashEquals(item.pollTokenSha256, pollHash)) throw new OperatorError('DEVICE_ENROLLMENT_UNAUTHORIZED', 'Device enrollment poll authority is invalid.');
      if (item.status === 'pending' || item.status === 'reserved') throw new OperatorError('DEVICE_ENROLLMENT_NOT_CLAIMED', 'Device enrollment is waiting for completed account binding.');
      if (item.status === 'issued') {
        if (item.sessionJti !== sessionJti) throw new OperatorError('DEVICE_ENROLLMENT_STATE_MISMATCH', 'Device enrollment session identity changed.');
        return publicRecord(item);
      }
      item.status = 'issued';
      item.sessionJti = sessionJti;
      item.issuedAt = this.#clock().toISOString();
      return publicRecord(item);
    });
  }
  async purgeDevice(deviceIdInput: string): Promise<number> {
    const deviceId = validUuid(deviceIdInput, 'deviceId');
    return await this.#mutate((state) => {
      const before = state.enrollments.length;
      state.enrollments = state.enrollments.filter((item) => item.deviceId !== deviceId);
      return before - state.enrollments.length;
    });
  }

  async #read(): Promise<EnrollmentState> {
    try {
      const text = await readDurableStateText(this.#file, {
        maxBytes: 4 * 1024 * 1024,
        errorCode: 'DEVICE_ENROLLMENT_STATE_CORRUPT',
        invalidMessage: 'Device enrollment state is invalid.'
      });
      return validateState(JSON.parse(text));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: VERSION, enrollments: [] };
      if (error instanceof OperatorError) throw error;
      throw new OperatorError('DEVICE_ENROLLMENT_STATE_CORRUPT', 'Device enrollment state could not be read.');
    }
  }

  async #write(stateInput: EnrollmentState): Promise<void> {
    const state = validateState(stateInput);
    await writeDurableStateText(this.#file, JSON.stringify(state, null, 2), {
      maxBytes: 4 * 1024 * 1024,
      errorCode: 'DEVICE_ENROLLMENT_STATE_CORRUPT',
      invalidMessage: 'Device enrollment state is invalid.'
    });
  }
  async #mutate<T>(mutator: (state: EnrollmentState) => T | Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.#queue;
    this.#queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const state = await this.#read();
      const value = await mutator(state);
      await this.#write(state);
      return value;
    } finally {
      release();
    }
  }
}

function validateState(input: EnrollmentState): EnrollmentState {
  if (!input || typeof input !== 'object' || input.version !== VERSION || !Array.isArray(input.enrollments) || input.enrollments.length > MAX_RECORDS) {
    throw new OperatorError('DEVICE_ENROLLMENT_STATE_CORRUPT', 'Device enrollment state structure is invalid.');
  }
  const ids = new Set<string>();
  const codes = new Set<string>();
  return { version: VERSION, enrollments: input.enrollments.map((raw) => {
    const item = validateStored(raw);
    if (ids.has(item.enrollmentId) || codes.has(item.userCodeSha256)) throw new OperatorError('DEVICE_ENROLLMENT_STATE_CORRUPT', 'Device enrollment state contains duplicate authority.');
    ids.add(item.enrollmentId); codes.add(item.userCodeSha256);
    return item;
  }) };
}
function validateStored(raw: StoredEnrollment): StoredEnrollment {
  const enrollmentId = validUuid(raw.enrollmentId, 'enrollmentId');
  const deviceId = validUuid(raw.deviceId, 'deviceId');
  const deviceName = boundedName(raw.deviceName);
  const fingerprint = validFingerprint(raw.fingerprint);
  const peerCreatedAt = raw.peerCreatedAt === undefined ? undefined : validIso(raw.peerCreatedAt, 'peerCreatedAt');
  const peerPublicKeyPem = raw.peerPublicKeyPem === undefined ? undefined : String(raw.peerPublicKeyPem);
  if (Boolean(peerCreatedAt) !== Boolean(peerPublicKeyPem)) throw new OperatorError('DEVICE_ENROLLMENT_STATE_CORRUPT', 'Provisional device identity is incomplete.');
  if (peerCreatedAt && peerPublicKeyPem) {
    const peer = normalizePeer({ deviceId, deviceName, createdAt: peerCreatedAt, publicKeyPem: peerPublicKeyPem, fingerprint });
    if (peer.fingerprint !== fingerprint) throw new OperatorError('DEVICE_ENROLLMENT_STATE_CORRUPT', 'Provisional device fingerprint changed.');
  }
  const status: EnrollmentStatus = raw.status === 'pending' || raw.status === 'reserved' || raw.status === 'claimed' || raw.status === 'issued'
    ? raw.status : (() => { throw new OperatorError('DEVICE_ENROLLMENT_STATE_CORRUPT', 'Device enrollment status is invalid.'); })();
  const createdAt = validIso(raw.createdAt, 'createdAt');
  const expiresAt = validIso(raw.expiresAt, 'expiresAt');
  if (Date.parse(expiresAt) <= Date.parse(createdAt) || Date.parse(expiresAt) - Date.parse(createdAt) > MAX_TTL_MS) {
    throw new OperatorError('DEVICE_ENROLLMENT_STATE_CORRUPT', 'Device enrollment lifetime is invalid.');
  }
  const userCodeSha256 = validHash(raw.userCodeSha256);
  const pollTokenSha256 = validHash(raw.pollTokenSha256);
  const accountId = raw.accountId === undefined ? undefined : validUuid(raw.accountId, 'accountId');
  const authorityGeneration = raw.authorityGeneration === undefined ? undefined : validGeneration(raw.authorityGeneration);
  const reservedAt = raw.reservedAt === undefined ? undefined : validIso(raw.reservedAt, 'reservedAt');
  const claimedAt = raw.claimedAt === undefined ? undefined : validIso(raw.claimedAt, 'claimedAt');
  const sessionJti = raw.sessionJti === undefined ? undefined : validUuid(raw.sessionJti, 'sessionJti');
  const issuedAt = raw.issuedAt === undefined ? undefined : validIso(raw.issuedAt, 'issuedAt');
  if (status === 'pending' && (accountId || authorityGeneration || reservedAt || claimedAt || sessionJti || issuedAt)) {
    throw new OperatorError('DEVICE_ENROLLMENT_STATE_CORRUPT', 'Pending enrollment contains reserved authority.');
  }
  if (status === 'reserved' && (!accountId || !reservedAt || authorityGeneration || claimedAt || sessionJti || issuedAt)) {
    throw new OperatorError('DEVICE_ENROLLMENT_STATE_CORRUPT', 'Reserved enrollment authority is incomplete.');
  }
  if (status === 'claimed' && (!accountId || !authorityGeneration || !reservedAt || !claimedAt || sessionJti || issuedAt)) {
    throw new OperatorError('DEVICE_ENROLLMENT_STATE_CORRUPT', 'Claimed enrollment authority is incomplete.');
  }
  if (status === 'issued' && (!accountId || !authorityGeneration || !reservedAt || !claimedAt || !sessionJti || !issuedAt)) {
    throw new OperatorError('DEVICE_ENROLLMENT_STATE_CORRUPT', 'Issued enrollment authority is incomplete.');
  }
  return { enrollmentId, deviceId, deviceName, fingerprint, status, createdAt, expiresAt,
    userCodeSha256, pollTokenSha256, peerCreatedAt, peerPublicKeyPem, accountId, authorityGeneration, reservedAt, claimedAt, sessionJti, issuedAt };
}

function prune(state: EnrollmentState, nowMs: number): void {
  state.enrollments = state.enrollments.filter((item) => {
    if (item.status === 'pending' && Date.parse(item.expiresAt) <= nowMs) return false;
    const reference = item.issuedAt ?? item.claimedAt ?? item.reservedAt ?? item.expiresAt;
    return nowMs - Date.parse(reference) <= RETENTION_MS;
  });
}

function publicRecord(item: StoredEnrollment): DeviceEnrollmentRecord {
  return {
    enrollmentId: item.enrollmentId, deviceId: item.deviceId, deviceName: item.deviceName,
    fingerprint: item.fingerprint, status: item.status, createdAt: item.createdAt, expiresAt: item.expiresAt,
    accountId: item.accountId, authorityGeneration: item.authorityGeneration,
    reservedAt: item.reservedAt, claimedAt: item.claimedAt, sessionJti: item.sessionJti, issuedAt: item.issuedAt
  };
}
function normalizePeer(input: PublicDeviceIdentity): PublicDeviceIdentity {
  const deviceId = validUuid(String(input?.deviceId ?? ''), 'deviceId');
  const deviceName = boundedName(String(input?.deviceName ?? ''));
  const createdAt = validIso(String(input?.createdAt ?? ''), 'peerCreatedAt');
  let publicKey: crypto.KeyObject;
  try { publicKey = crypto.createPublicKey(String(input?.publicKeyPem ?? '')); }
  catch { throw new OperatorError('DEVICE_ENROLLMENT_INPUT_INVALID', 'Provisional device public key is invalid.'); }
  if (publicKey.asymmetricKeyType !== 'ed25519') throw new OperatorError('DEVICE_ENROLLMENT_INPUT_INVALID', 'Provisional device key must be Ed25519.');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const fingerprint = crypto.createHash('sha256').update(publicKeyPem).digest('base64url');
  if (fingerprint !== validFingerprint(String(input?.fingerprint ?? ''))) throw new OperatorError('DEVICE_ENROLLMENT_INPUT_INVALID', 'Provisional device fingerprint does not match its key.');
  return { deviceId, deviceName, createdAt, publicKeyPem, fingerprint };
}

function boundedTtl(input: number): number {
  const value = Number(input);
  if (!Number.isInteger(value) || value < MIN_TTL_MS || value > MAX_TTL_MS) {
    throw new OperatorError('DEVICE_ENROLLMENT_TTL_INVALID', `Device enrollment TTL must be between ${MIN_TTL_MS} and ${MAX_TTL_MS} ms.`);
  }
  return value;
}

function boundedName(input: string): string {
  const value = String(input ?? '').trim();
  if (!value || value.length > 128 || /[\0\r\n]/.test(value)) {
    throw new OperatorError('DEVICE_ENROLLMENT_INPUT_INVALID', 'Device enrollment name is invalid.');
  }
  return value;
}

function boundedPollToken(input: string): string {
  const value = String(input ?? '').trim();
  if (!/^[A-Za-z0-9_-]{40,128}$/.test(value)) {
    throw new OperatorError('DEVICE_ENROLLMENT_UNAUTHORIZED', 'Device enrollment poll authority is invalid.');
  }
  return value;
}
function normalizeUserCode(input: string): string {
  const compact = String(input ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(compact)) {
    throw new OperatorError('DEVICE_ENROLLMENT_CODE_INVALID', 'Device enrollment code is invalid or expired.');
  }
  return compact;
}

function userCodeFor(enrollmentId: string, pollToken: string): string {
  const digest = crypto.createHash('sha256').update('operator-device-enrollment-v1:display:').update(enrollmentId).update(':').update(pollToken).digest();
  let value = '';
  for (let index = 0; index < 8; index += 1) value += CODE_ALPHABET[digest[index]! % CODE_ALPHABET.length];
  digest.fill(0);
  return `${value.slice(0, 4)}-${value.slice(4)}`;
}

function secretHash(domain: 'code' | 'poll', value: string): string {
  return crypto.createHash('sha256').update(`operator-device-enrollment-v1:${domain}:`).update(value).digest('hex');
}

function hashEquals(left: string, right: string): boolean {
  const a = Buffer.from(validHash(left), 'hex');
  const b = Buffer.from(validHash(right), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function validHash(input: string): string {
  const value = String(input ?? '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(value)) throw new OperatorError('DEVICE_ENROLLMENT_STATE_CORRUPT', 'Device enrollment secret hash is invalid.');
  return value;
}

function validFingerprint(input: string): string {
  const value = String(input ?? '');
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(value)) throw new OperatorError('DEVICE_ENROLLMENT_INPUT_INVALID', 'Device fingerprint is invalid.');
  return value;
}

function validGeneration(input: number): number {
  const value = Number(input);
  if (!Number.isSafeInteger(value) || value < 1) throw new OperatorError('DEVICE_ENROLLMENT_INPUT_INVALID', 'Device authority generation is invalid.');
  return value;
}

function validUuid(input: string, label: string): string {
  const value = String(input ?? '').toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw new OperatorError('DEVICE_ENROLLMENT_INPUT_INVALID', `${label} must be a UUID.`);
  }
  return value;
}
function validIso(input: string, label: string): string {
  const value = String(input ?? '');
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    throw new OperatorError('DEVICE_ENROLLMENT_STATE_CORRUPT', `${label} must be an ISO timestamp.`);
  }
  return value;
}


export function enrollmentPollBinding(enrollmentIdInput: string, deviceIdInput: string, pollTokenInput: string): Buffer {
  const enrollmentId = validUuid(enrollmentIdInput, 'enrollmentId');
  const deviceId = validUuid(deviceIdInput, 'deviceId');
  const pollToken = boundedPollToken(pollTokenInput);
  return Buffer.from(JSON.stringify({
    version: 1,
    purpose: 'operator-device-enrollment-poll-v1',
    enrollmentId,
    deviceId,
    pollToken
  }), 'utf8');
}
