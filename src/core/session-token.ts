import crypto from 'node:crypto';
import path from 'node:path';
import { DeviceIdentityStore } from './device-identity.ts';
import { DeviceRegistryStore, type RegisteredDevice } from './device-registry.ts';
import { OperatorError } from './errors.ts';
import { readDurableStateText, writeDurableStateText } from './durable-state.ts';

const PURPOSE = 'operator-session-v1';
const MAX_TOKEN_BYTES = 16 * 1024;
const MAX_PAYLOAD_BYTES = 8 * 1024;
const MAX_TTL_MS = 15 * 60_000;
const MIN_TTL_MS = 30_000;
const MAX_SCOPES = 64;
const MAX_RECORDS = 4096;
const RETENTION_MS = 24 * 60 * 60_000;

type Clock = () => Date;

export interface DeviceSessionPayload {
  version: 1;
  purpose: typeof PURPOSE;
  jti: string;
  issuerDeviceId: string;
  issuerFingerprint: string;
  subjectDeviceId: string;
  subjectFingerprint: string;
  audience: string;
  scopes: string[];
  issuedAt: string;
  expiresAt: string;
}

export interface IssuedSessionRecord extends Omit<DeviceSessionPayload, 'version' | 'purpose' | 'issuerFingerprint' | 'subjectFingerprint'> {
  status: 'active' | 'revoked';
  revokedAt?: string;
  revokedReason?: string;
}

type SessionState = { version: 1; issued: IssuedSessionRecord[] };

export class DeviceSessionTokenStore {
  #file: string;
  #identity: DeviceIdentityStore;
  #registry: DeviceRegistryStore;
  #clock: Clock;
  #queue: Promise<void> = Promise.resolve();

  constructor(stateDir: string, identity: DeviceIdentityStore, registry: DeviceRegistryStore, options: { clock?: Clock } = {}) {
    this.#file = path.join(path.resolve(stateDir), 'device-sessions.json');
    this.#identity = identity;
    this.#registry = registry;
    this.#clock = options.clock ?? (() => new Date());
  }

  async issue(options: { subjectDeviceId: string; audience: string; scopes: string[]; ttlMs?: number }): Promise<{ token: string; payload: DeviceSessionPayload }> {
    const local = await this.#identity.loadOrCreate();
    const peer = await this.#activePeer(options.subjectDeviceId);
    const audience = validAudience(options.audience);
    const scopes = validScopes(options.scopes);
    const ttlMs = boundedTtl(options.ttlMs ?? 5 * 60_000);
    const now = this.#clock();
    const payload: DeviceSessionPayload = {
      version: 1,
      purpose: PURPOSE,
      jti: crypto.randomUUID(),
      issuerDeviceId: local.deviceId,
      issuerFingerprint: local.fingerprint,
      subjectDeviceId: peer.deviceId,
      subjectFingerprint: peer.fingerprint,
      audience,
      scopes,
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMs).toISOString()
    };
    const payloadBytes = encodePayload(payload);
    const signature = await this.#identity.sign(payloadBytes);
    const token = `${payloadBytes.toString('base64url')}.${signature}`;
    if (Buffer.byteLength(token, 'utf8') > MAX_TOKEN_BYTES) throw new OperatorError('SESSION_TOKEN_TOO_LARGE', 'Generated session token exceeded the bounded size.');

    await this.#mutate((state) => {
      prune(state, now.getTime());
      if (state.issued.length >= MAX_RECORDS) throw new OperatorError('SESSION_RECORD_LIMIT', `At most ${MAX_RECORDS} session records may be retained.`);
      state.issued.push(recordFrom(payload));
    });
    return { token, payload };
  }

  async rotate(jtiInput: string, options: { ttlMs?: number } = {}): Promise<{ token: string; payload: DeviceSessionPayload }> {
    const jti = validUuid(jtiInput, 'jti');
    const snapshot = (await this.#read()).issued.find((candidate) => candidate.jti === jti);
    if (!snapshot) throw new OperatorError('SESSION_NOT_FOUND', 'Issued session was not found.');
    if (snapshot.status !== 'active') throw new OperatorError('SESSION_REVOKED', 'Issued session is revoked.');
    const now = this.#clock();
    if (Date.parse(snapshot.expiresAt) <= now.getTime()) throw new OperatorError('SESSION_EXPIRED', 'Issued session has expired.');

    const local = await this.#identity.loadOrCreate();
    const peer = await this.#activePeer(snapshot.subjectDeviceId);
    const ttlMs = boundedTtl(options.ttlMs ?? 5 * 60_000);
    const payload: DeviceSessionPayload = {
      version: 1,
      purpose: PURPOSE,
      jti: crypto.randomUUID(),
      issuerDeviceId: local.deviceId,
      issuerFingerprint: local.fingerprint,
      subjectDeviceId: peer.deviceId,
      subjectFingerprint: peer.fingerprint,
      audience: snapshot.audience,
      scopes: [...snapshot.scopes],
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMs).toISOString()
    };
    const payloadBytes = encodePayload(payload);
    const signature = await this.#identity.sign(payloadBytes);
    const token = `${payloadBytes.toString('base64url')}.${signature}`;
    if (Buffer.byteLength(token, 'utf8') > MAX_TOKEN_BYTES) throw new OperatorError('SESSION_TOKEN_TOO_LARGE', 'Generated session token exceeded the bounded size.');

    await this.#mutate((state) => {
      prune(state, now.getTime());
      const current = state.issued.find((candidate) => candidate.jti === jti);
      if (!current) throw new OperatorError('SESSION_NOT_FOUND', 'Issued session was not found during rotation.');
      if (current.status !== 'active') throw new OperatorError('SESSION_REVOKED', 'Issued session was revoked during rotation.');
      if (Date.parse(current.expiresAt) <= now.getTime()) throw new OperatorError('SESSION_EXPIRED', 'Issued session expired during rotation.');
      if (current.subjectDeviceId !== snapshot.subjectDeviceId || current.audience !== snapshot.audience || JSON.stringify(current.scopes) !== JSON.stringify(snapshot.scopes)) {
        throw new OperatorError('SESSION_STATE_MISMATCH', 'Issued session changed during rotation.');
      }
      if (state.issued.length >= MAX_RECORDS) throw new OperatorError('SESSION_RECORD_LIMIT', `At most ${MAX_RECORDS} session records may be retained.`);
      current.status = 'revoked';
      current.revokedAt = now.toISOString();
      current.revokedReason = `rotated:${payload.jti}`;
      state.issued.push(recordFrom(payload));
    });
    return { token, payload };
  }

  async revoke(jtiInput: string, reasonInput?: string): Promise<IssuedSessionRecord> {
    const jti = validUuid(jtiInput, 'jti');
    const reason = reasonInput === undefined ? undefined : validReason(reasonInput);
    return await this.#mutate((state) => {
      const record = state.issued.find((candidate) => candidate.jti === jti);
      if (!record) throw new OperatorError('SESSION_NOT_FOUND', 'Issued session was not found.');
      if (record.status === 'revoked') return { ...record, scopes: [...record.scopes] };
      record.status = 'revoked';
      record.revokedAt = this.#clock().toISOString();
      record.revokedReason = reason;
      return { ...record, scopes: [...record.scopes] };
    });
  }

  async listIssued(limit = 100): Promise<IssuedSessionRecord[]> {
    const parsedLimit = Number(limit);
    const bounded = Number.isFinite(parsedLimit) ? Math.min(Math.max(Math.trunc(parsedLimit), 1), 500) : 100;
    const state = await this.#read();
    return state.issued.slice(-bounded).reverse().map((record) => ({ ...record, scopes: [...record.scopes] }));
  }

  async verify(tokenInput: string, options: { audience: string; requiredScopes?: string[]; expectedSubjectDeviceId?: string }): Promise<DeviceSessionPayload> {
    const { payload, payloadBytes, signature } = parseToken(tokenInput);
    const audience = validAudience(options.audience);
    if (payload.audience !== audience) throw new OperatorError('SESSION_AUDIENCE_MISMATCH', 'Session token audience does not match this service.');
    const requiredScopes = validScopes(options.requiredScopes ?? []);
    for (const scope of requiredScopes) {
      if (!payload.scopes.includes(scope)) throw new OperatorError('SESSION_SCOPE_DENIED', `Session token is missing required scope ${scope}.`);
    }
    if (options.expectedSubjectDeviceId && payload.subjectDeviceId !== validUuid(options.expectedSubjectDeviceId, 'expectedSubjectDeviceId')) {
      throw new OperatorError('SESSION_SUBJECT_MISMATCH', 'Session token subject does not match the expected device.');
    }
    const now = this.#clock().getTime();
    if (Date.parse(payload.issuedAt) > now + 30_000) throw new OperatorError('SESSION_NOT_YET_VALID', 'Session token issue time is too far in the future.');
    if (Date.parse(payload.expiresAt) <= now) throw new OperatorError('SESSION_EXPIRED', 'Session token has expired.');

    const local = await this.#identity.loadOrCreate();
    let verified = false;
    if (payload.issuerDeviceId === local.deviceId) {
      if (payload.issuerFingerprint !== local.fingerprint) throw new OperatorError('SESSION_ISSUER_MISMATCH', 'Local issuer fingerprint does not match this device.');
      verified = await this.#identity.verify(payloadBytes, signature);
      const record = (await this.#read()).issued.find((candidate) => candidate.jti === payload.jti);
      if (!record) throw new OperatorError('SESSION_NOT_FOUND', 'Locally issued session is not present in the session registry.');
      if (record.status !== 'active') throw new OperatorError('SESSION_REVOKED', 'Session token has been revoked.');
      if (!sameRecord(record, payload)) throw new OperatorError('SESSION_STATE_MISMATCH', 'Session token no longer matches its issued registry record.');
    } else {
      const issuer = await this.#activePeer(payload.issuerDeviceId);
      if (issuer.fingerprint !== payload.issuerFingerprint) throw new OperatorError('SESSION_ISSUER_MISMATCH', 'Remote issuer fingerprint does not match the paired device.');
      verified = await this.#registry.verifyDeviceSignature(payload.issuerDeviceId, payloadBytes, signature);
    }
    if (!verified) throw new OperatorError('SESSION_SIGNATURE_INVALID', 'Session token signature could not be verified.');

    const subject = payload.subjectDeviceId === local.deviceId ? local : await this.#activePeer(payload.subjectDeviceId);
    if (subject.fingerprint !== payload.subjectFingerprint) throw new OperatorError('SESSION_SUBJECT_MISMATCH', 'Session token subject fingerprint does not match the registered device.');
    return payload;
  }

  async #activePeer(deviceIdInput: string): Promise<RegisteredDevice> {
    const deviceId = validUuid(deviceIdInput, 'deviceId');
    const peer = (await this.#registry.listDevices()).find((candidate) => candidate.deviceId === deviceId);
    if (!peer) throw new OperatorError('DEVICE_NOT_FOUND', 'Session peer device is not paired.');
    if (peer.status !== 'active') throw new OperatorError('DEVICE_REVOKED', 'Session peer device is revoked.');
    return peer;
  }

  async #read(): Promise<SessionState> {
    try {
      const text = await readDurableStateText(this.#file, {
        maxBytes: 2 * 1024 * 1024,
        errorCode: 'SESSION_STATE_CORRUPT',
        invalidMessage: 'Session registry is invalid.'
      });
      return validateState(JSON.parse(text));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, issued: [] };
      if (error instanceof OperatorError) throw error;
      throw new OperatorError('SESSION_STATE_CORRUPT', 'Session registry could not be read.');
    }
  }

  async #write(state: SessionState): Promise<void> {
    const state = validateState(state);
    await writeDurableStateText(this.#file, JSON.stringify(state, null, 2), {
      maxBytes: 2 * 1024 * 1024,
      errorCode: 'SESSION_STATE_CORRUPT',
      invalidMessage: 'Session registry is invalid.'
    });
  }

  async #mutate<T>(mutator: (state: SessionState) => T | Promise<T>): Promise<T> {
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

function encodePayload(payloadInput: DeviceSessionPayload): Buffer {
  const payload = validatePayload(payloadInput);
  const bytes = Buffer.from(JSON.stringify({
    version: 1,
    purpose: PURPOSE,
    jti: payload.jti,
    issuerDeviceId: payload.issuerDeviceId,
    issuerFingerprint: payload.issuerFingerprint,
    subjectDeviceId: payload.subjectDeviceId,
    subjectFingerprint: payload.subjectFingerprint,
    audience: payload.audience,
    scopes: payload.scopes,
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt
  }), 'utf8');
  if (bytes.byteLength > MAX_PAYLOAD_BYTES) throw new OperatorError('SESSION_TOKEN_TOO_LARGE', 'Session token payload exceeds the bounded size.');
  return bytes;
}

function parseToken(tokenInput: string): { payload: DeviceSessionPayload; payloadBytes: Buffer; signature: string } {
  const token = String(tokenInput ?? '');
  if (!token || Buffer.byteLength(token, 'utf8') > MAX_TOKEN_BYTES) throw new OperatorError('SESSION_TOKEN_INVALID', 'Session token is missing or too large.');
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !/^[A-Za-z0-9_-]{40,256}$/.test(parts[1])) throw new OperatorError('SESSION_TOKEN_INVALID', 'Session token format is invalid.');
  let payloadBytes: Buffer;
  let parsed: unknown;
  try {
    payloadBytes = Buffer.from(parts[0], 'base64url');
    if (payloadBytes.byteLength > MAX_PAYLOAD_BYTES) throw new Error('large');
    parsed = JSON.parse(payloadBytes.toString('utf8'));
  } catch { throw new OperatorError('SESSION_TOKEN_INVALID', 'Session token payload is invalid.'); }
  const payload = validatePayload(parsed as DeviceSessionPayload);
  if (!payloadBytes.equals(encodePayload(payload))) throw new OperatorError('SESSION_TOKEN_INVALID', 'Session token payload is not in canonical form.');
  return { payload, payloadBytes, signature: parts[1] };
}

function validatePayload(input: DeviceSessionPayload): DeviceSessionPayload {
  if (!input || typeof input !== 'object' || input.version !== 1 || input.purpose !== PURPOSE) throw new OperatorError('SESSION_TOKEN_INVALID', 'Session token payload version or purpose is invalid.');
  const jti = validUuid(String(input.jti ?? ''), 'jti');
  const issuerDeviceId = validUuid(String(input.issuerDeviceId ?? ''), 'issuerDeviceId');
  const subjectDeviceId = validUuid(String(input.subjectDeviceId ?? ''), 'subjectDeviceId');
  const issuerFingerprint = validFingerprint(String(input.issuerFingerprint ?? ''), 'issuerFingerprint');
  const subjectFingerprint = validFingerprint(String(input.subjectFingerprint ?? ''), 'subjectFingerprint');
  const audience = validAudience(String(input.audience ?? ''));
  const scopes = validScopes(input.scopes);
  const issuedAt = validIso(String(input.issuedAt ?? ''), 'issuedAt');
  const expiresAt = validIso(String(input.expiresAt ?? ''), 'expiresAt');
  const lifetime = Date.parse(expiresAt) - Date.parse(issuedAt);
  if (lifetime < MIN_TTL_MS || lifetime > MAX_TTL_MS) throw new OperatorError('SESSION_TOKEN_INVALID', 'Session token lifetime is outside the allowed range.');
  return { version: 1, purpose: PURPOSE, jti, issuerDeviceId, issuerFingerprint, subjectDeviceId, subjectFingerprint, audience, scopes, issuedAt, expiresAt };
}

function validateState(input: SessionState): SessionState {
  if (!input || typeof input !== 'object' || input.version !== 1 || !Array.isArray(input.issued) || input.issued.length > MAX_RECORDS) throw new OperatorError('SESSION_STATE_CORRUPT', 'Session registry structure is invalid.');
  const seen = new Set<string>();
  const issued = input.issued.map((raw) => {
    const jti = validUuid(String(raw.jti ?? ''), 'jti');
    if (seen.has(jti)) throw new OperatorError('SESSION_STATE_CORRUPT', 'Session registry contains duplicate token IDs.');
    seen.add(jti);
    const issuerDeviceId = validUuid(String(raw.issuerDeviceId ?? ''), 'issuerDeviceId');
    const subjectDeviceId = validUuid(String(raw.subjectDeviceId ?? ''), 'subjectDeviceId');
    const audience = validAudience(String(raw.audience ?? ''));
    const scopes = validScopes(raw.scopes);
    const issuedAt = validIso(String(raw.issuedAt ?? ''), 'issuedAt');
    const expiresAt = validIso(String(raw.expiresAt ?? ''), 'expiresAt');
    const status = raw.status === 'active' ? 'active' : raw.status === 'revoked' ? 'revoked' : null;
    if (!status) throw new OperatorError('SESSION_STATE_CORRUPT', 'Session status is invalid.');
    const revokedAt = raw.revokedAt === undefined ? undefined : validIso(String(raw.revokedAt), 'revokedAt');
    const revokedReason = raw.revokedReason === undefined ? undefined : validReason(String(raw.revokedReason));
    if (status === 'active' && revokedAt) throw new OperatorError('SESSION_STATE_CORRUPT', 'Active session cannot have a revocation timestamp.');
    return { jti, issuerDeviceId, subjectDeviceId, audience, scopes, issuedAt, expiresAt, status, revokedAt, revokedReason } satisfies IssuedSessionRecord;
  });
  return { version: 1, issued };
}

function recordFrom(payload: DeviceSessionPayload): IssuedSessionRecord {
  return {
    jti: payload.jti,
    issuerDeviceId: payload.issuerDeviceId,
    subjectDeviceId: payload.subjectDeviceId,
    audience: payload.audience,
    scopes: [...payload.scopes],
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
    status: 'active'
  };
}

function sameRecord(record: IssuedSessionRecord, payload: DeviceSessionPayload): boolean {
  return record.jti === payload.jti && record.issuerDeviceId === payload.issuerDeviceId && record.subjectDeviceId === payload.subjectDeviceId && record.audience === payload.audience && record.issuedAt === payload.issuedAt && record.expiresAt === payload.expiresAt && JSON.stringify(record.scopes) === JSON.stringify(payload.scopes);
}

function prune(state: SessionState, nowMs: number): void {
  state.issued = state.issued.filter((record) => nowMs - Date.parse(record.expiresAt) <= RETENTION_MS);
}

function boundedTtl(value: number): number {
  if (!Number.isInteger(value) || value < MIN_TTL_MS || value > MAX_TTL_MS) throw new OperatorError('SESSION_TTL_INVALID', `Session TTL must be between ${MIN_TTL_MS} and ${MAX_TTL_MS} ms.`);
  return value;
}

function validScopes(input: unknown): string[] {
  if (!Array.isArray(input) || input.length > MAX_SCOPES) throw new OperatorError('SESSION_SCOPE_INVALID', `Session scopes must contain at most ${MAX_SCOPES} entries.`);
  const scopes = input.map((scope) => String(scope));
  for (const scope of scopes) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/*-]{0,127}$/.test(scope)) throw new OperatorError('SESSION_SCOPE_INVALID', `Invalid session scope ${scope}.`);
  }
  return [...new Set(scopes)].sort();
}

function validAudience(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new OperatorError('SESSION_AUDIENCE_INVALID', 'Session audience is invalid.');
  return value;
}

function validFingerprint(value: string, label: string): string {
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(value)) throw new OperatorError('SESSION_TOKEN_INVALID', `${label} is invalid.`);
  return value;
}

function validUuid(value: string, label: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new OperatorError('SESSION_TOKEN_INVALID', `${label} must be a UUID.`);
  return value.toLowerCase();
}

function validIso(value: string, label: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) throw new OperatorError('SESSION_TOKEN_INVALID', `${label} must be an ISO timestamp.`);
  return value;
}

function validReason(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 512 || /\0/.test(trimmed)) throw new OperatorError('SESSION_REVOCATION_REASON_INVALID', 'Session revocation reason is invalid.');
  return trimmed;
}
