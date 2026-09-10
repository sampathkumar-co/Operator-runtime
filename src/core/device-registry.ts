import crypto from 'node:crypto';
import path from 'node:path';
import { DeviceIdentityStore, type PublicDeviceIdentity } from './device-identity.ts';
import { OperatorError } from './errors.ts';
import { readDurableStateText, writeDurableStateText } from './durable-state.ts';

const MAX_DEVICES = 1000;
const MAX_CHALLENGES = 128;
const MAX_TTL_MS = 5 * 60_000;
const MIN_TTL_MS = 30_000;
const CHALLENGE_RETENTION_MS = 24 * 60 * 60_000;
const DEVICE_NAME_MAX = 128;
const REASON_MAX = 512;
const PURPOSE = 'operator-pairing-v1';

export interface PublicPairingChallenge {
  version: 1;
  purpose: typeof PURPOSE;
  challengeId: string;
  issuerDeviceId: string;
  issuerFingerprint: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  expectedPeerDeviceId?: string;
}

export interface PairingResponse {
  challengeId: string;
  peer: PublicDeviceIdentity;
  signature: string;
}

export interface RegisteredDevice {
  deviceId: string;
  deviceName: string;
  createdAt: string;
  publicKeyPem: string;
  fingerprint: string;
  status: 'active' | 'revoked';
  pairedAt: string;
  revokedAt?: string;
  revokedReason?: string;
}

type StoredChallenge = PublicPairingChallenge & { consumedAt?: string };
type RegistryState = { version: 1; devices: RegisteredDevice[]; challenges: StoredChallenge[] };

type Clock = () => Date;

export class DeviceRegistryStore {
  #file: string;
  #clock: Clock;
  #queue: Promise<void> = Promise.resolve();

  constructor(stateDir: string, options: { clock?: Clock } = {}) {
    this.#file = path.join(path.resolve(stateDir), 'device-registry.json');
    this.#clock = options.clock ?? (() => new Date());
  }

  async listDevices(): Promise<RegisteredDevice[]> {
    const state = await this.#read();
    return state.devices.map((device) => ({ ...device }));
  }

  async issuePairingChallenge(
    issuer: PublicDeviceIdentity,
    options: { expectedPeerDeviceId?: string; ttlMs?: number } = {}
  ): Promise<PublicPairingChallenge> {
    const normalizedIssuer = normalizePublicIdentity(issuer);
    const ttlMs = boundedTtl(options.ttlMs ?? 120_000);
    const expectedPeerDeviceId = options.expectedPeerDeviceId === undefined
      ? undefined
      : validUuid(options.expectedPeerDeviceId, 'expectedPeerDeviceId');
    const now = this.#clock();
    const challenge: StoredChallenge = {
      version: 1,
      purpose: PURPOSE,
      challengeId: crypto.randomUUID(),
      issuerDeviceId: normalizedIssuer.deviceId,
      issuerFingerprint: normalizedIssuer.fingerprint,
      nonce: crypto.randomBytes(32).toString('base64url'),
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      expectedPeerDeviceId
    };

    await this.#mutate((state) => {
      pruneChallenges(state, now.getTime());
      if (state.challenges.length >= MAX_CHALLENGES) {
        throw new OperatorError('PAIRING_CHALLENGE_LIMIT', `At most ${MAX_CHALLENGES} pairing challenges may be retained.`);
      }
      state.challenges.push(challenge);
    });
    return publicChallenge(challenge);
  }

  async completePairing(response: PairingResponse): Promise<RegisteredDevice> {
    if (!response || typeof response !== 'object') throw new OperatorError('PAIRING_RESPONSE_INVALID', 'Pairing response is invalid.');
    const challengeId = validUuid(response.challengeId, 'challengeId');
    const peer = normalizePublicIdentity(response.peer);
    const signature = String(response.signature ?? '');
    if (!/^[A-Za-z0-9_-]{40,256}$/.test(signature)) {
      throw new OperatorError('PAIRING_SIGNATURE_INVALID', 'Pairing response signature is malformed.');
    }

    return await this.#mutate((state) => {
      const now = this.#clock();
      pruneChallenges(state, now.getTime());
      const challenge = state.challenges.find((candidate) => candidate.challengeId === challengeId);
      if (!challenge) throw new OperatorError('PAIRING_CHALLENGE_NOT_FOUND', 'Pairing challenge was not found or is no longer retained.');
      if (challenge.consumedAt) throw new OperatorError('PAIRING_CHALLENGE_REPLAY', 'Pairing challenge has already been consumed.');
      if (Date.parse(challenge.expiresAt) < now.getTime()) throw new OperatorError('PAIRING_CHALLENGE_EXPIRED', 'Pairing challenge has expired.');
      if (challenge.expectedPeerDeviceId && challenge.expectedPeerDeviceId !== peer.deviceId) {
        throw new OperatorError('PAIRING_PEER_MISMATCH', 'Pairing response came from a different device than the challenge expected.');
      }

      const payload = pairingPayload(challenge, peer);
      let verified = false;
      try {
        verified = crypto.verify(null, payload, peer.publicKeyPem, Buffer.from(signature, 'base64url'));
      } catch {
        verified = false;
      }
      if (!verified) throw new OperatorError('PAIRING_SIGNATURE_INVALID', 'Pairing response signature could not be verified.');

      const sameId = state.devices.find((device) => device.deviceId === peer.deviceId);
      const sameFingerprint = state.devices.find((device) => device.fingerprint === peer.fingerprint);
      if (sameId && sameId.fingerprint !== peer.fingerprint) {
        throw new OperatorError('DEVICE_IDENTITY_CONFLICT', 'The device ID is already registered with a different public key.');
      }
      if (sameFingerprint && sameFingerprint.deviceId !== peer.deviceId) {
        throw new OperatorError('DEVICE_IDENTITY_CONFLICT', 'The public-key fingerprint is already registered to a different device ID.');
      }
      if (sameId?.status === 'revoked') {
        throw new OperatorError('DEVICE_REVOKED', 'This device identity is revoked and cannot be silently reactivated by pairing.');
      }
      if (!sameId && state.devices.length >= MAX_DEVICES) {
        throw new OperatorError('DEVICE_REGISTRY_LIMIT', `At most ${MAX_DEVICES} peer devices may be registered.`);
      }

      const pairedAt = now.toISOString();
      const registered: RegisteredDevice = sameId ?? {
        deviceId: peer.deviceId,
        deviceName: peer.deviceName,
        createdAt: peer.createdAt,
        publicKeyPem: peer.publicKeyPem,
        fingerprint: peer.fingerprint,
        status: 'active',
        pairedAt
      };
      if (!sameId) state.devices.push(registered);
      else {
        sameId.deviceName = peer.deviceName;
        sameId.createdAt = peer.createdAt;
        sameId.publicKeyPem = peer.publicKeyPem;
        sameId.pairedAt = pairedAt;
      }
      challenge.consumedAt = pairedAt;
      return { ...registered };
    });
  }

  async revokeDevice(deviceIdInput: string, reasonInput?: string): Promise<RegisteredDevice> {
    const deviceId = validUuid(deviceIdInput, 'deviceId');
    const reason = reasonInput === undefined ? undefined : boundedReason(reasonInput);
    return await this.#mutate((state) => {
      const device = state.devices.find((candidate) => candidate.deviceId === deviceId);
      if (!device) throw new OperatorError('DEVICE_NOT_FOUND', 'Registered device was not found.');
      if (device.status === 'revoked') return { ...device };
      device.status = 'revoked';
      device.revokedAt = this.#clock().toISOString();
      device.revokedReason = reason;
      return { ...device };
    });
  }

  async verifyDeviceSignature(deviceIdInput: string, payload: Uint8Array, signatureInput: string): Promise<boolean> {
    const deviceId = validUuid(deviceIdInput, 'deviceId');
    const signature = String(signatureInput ?? '');
    const state = await this.#read();
    const device = state.devices.find((candidate) => candidate.deviceId === deviceId);
    if (!device) throw new OperatorError('DEVICE_NOT_FOUND', 'Registered device was not found.');
    if (device.status !== 'active') throw new OperatorError('DEVICE_REVOKED', 'Registered device is revoked.');
    try {
      return crypto.verify(null, payload, device.publicKeyPem, Buffer.from(signature, 'base64url'));
    } catch {
      return false;
    }
  }

  async #read(): Promise<RegistryState> {
    try {
      const text = await readDurableStateText(this.#file, {
        maxBytes: 2 * 1024 * 1024,
        errorCode: 'DEVICE_REGISTRY_CORRUPT',
        invalidMessage: 'Device registry is invalid.'
      });
      return validateState(JSON.parse(text));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, devices: [], challenges: [] };
      if (error instanceof OperatorError) throw error;
      throw new OperatorError('DEVICE_REGISTRY_CORRUPT', 'Device registry could not be read.');
    }
  }

  async #write(state: RegistryState): Promise<void> {
    const state = validateState(state);
    await writeDurableStateText(this.#file, JSON.stringify(state, null, 2), {
      maxBytes: 2 * 1024 * 1024,
      errorCode: 'DEVICE_REGISTRY_CORRUPT',
      invalidMessage: 'Device registry is invalid.'
    });
  }

  async #mutate<T>(mutator: (state: RegistryState) => T | Promise<T>): Promise<T> {
    let resolveTurn!: () => void;
    const previous = this.#queue;
    this.#queue = new Promise<void>((resolve) => { resolveTurn = resolve; });
    await previous;
    try {
      const state = await this.#read();
      const result = await mutator(state);
      await this.#write(state);
      return result;
    } finally {
      resolveTurn();
    }
  }
}

export async function answerPairingChallenge(
  challengeInput: PublicPairingChallenge,
  identityStore: DeviceIdentityStore,
  deviceName?: string
): Promise<PairingResponse> {
  const challenge = validateChallenge(challengeInput);
  const peer = normalizePublicIdentity(await identityStore.loadOrCreate(deviceName));
  if (challenge.expectedPeerDeviceId && challenge.expectedPeerDeviceId !== peer.deviceId) {
    throw new OperatorError('PAIRING_PEER_MISMATCH', 'This pairing challenge is intended for a different device.');
  }
  const signature = await identityStore.sign(pairingPayload(challenge, peer));
  return { challengeId: challenge.challengeId, peer, signature };
}

function pairingPayload(challengeInput: PublicPairingChallenge, peerInput: PublicDeviceIdentity): Buffer {
  const challenge = validateChallenge(challengeInput);
  const peer = normalizePublicIdentity(peerInput);
  return Buffer.from(JSON.stringify({
    version: 1,
    purpose: PURPOSE,
    challengeId: challenge.challengeId,
    issuerDeviceId: challenge.issuerDeviceId,
    issuerFingerprint: challenge.issuerFingerprint,
    nonce: challenge.nonce,
    issuedAt: challenge.issuedAt,
    expiresAt: challenge.expiresAt,
    expectedPeerDeviceId: challenge.expectedPeerDeviceId ?? null,
    peerDeviceId: peer.deviceId,
    peerDeviceName: peer.deviceName,
    peerCreatedAt: peer.createdAt,
    peerFingerprint: peer.fingerprint,
    peerPublicKeyPem: peer.publicKeyPem
  }), 'utf8');
}

function normalizePublicIdentity(input: PublicDeviceIdentity): PublicDeviceIdentity {
  if (!input || typeof input !== 'object') throw new OperatorError('DEVICE_IDENTITY_INVALID', 'Public device identity is invalid.');
  const deviceId = validUuid(String(input.deviceId ?? ''), 'deviceId');
  const deviceName = boundedDeviceName(String(input.deviceName ?? ''));
  const createdAt = validIsoDate(String(input.createdAt ?? ''), 'createdAt');
  let publicKey: crypto.KeyObject;
  try { publicKey = crypto.createPublicKey(String(input.publicKeyPem ?? '')); }
  catch { throw new OperatorError('DEVICE_IDENTITY_INVALID', 'Public device key is invalid.'); }
  if (publicKey.asymmetricKeyType !== 'ed25519') throw new OperatorError('DEVICE_IDENTITY_INVALID', 'Public device key must be Ed25519.');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const fingerprint = crypto.createHash('sha256').update(publicKeyPem).digest('base64url');
  if (fingerprint !== String(input.fingerprint ?? '')) {
    throw new OperatorError('DEVICE_IDENTITY_INVALID', 'Public device fingerprint does not match the public key.');
  }
  return { deviceId, deviceName, createdAt, publicKeyPem, fingerprint };
}

function validateChallenge(input: PublicPairingChallenge): PublicPairingChallenge {
  if (!input || typeof input !== 'object' || input.version !== 1 || input.purpose !== PURPOSE) {
    throw new OperatorError('PAIRING_CHALLENGE_INVALID', 'Pairing challenge is invalid.');
  }
  const challengeId = validUuid(String(input.challengeId ?? ''), 'challengeId');
  const issuerDeviceId = validUuid(String(input.issuerDeviceId ?? ''), 'issuerDeviceId');
  const issuerFingerprint = String(input.issuerFingerprint ?? '');
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(issuerFingerprint)) throw new OperatorError('PAIRING_CHALLENGE_INVALID', 'Pairing issuer fingerprint is invalid.');
  const nonce = String(input.nonce ?? '');
  if (!/^[A-Za-z0-9_-]{40,128}$/.test(nonce)) throw new OperatorError('PAIRING_CHALLENGE_INVALID', 'Pairing nonce is invalid.');
  const issuedAt = validIsoDate(String(input.issuedAt ?? ''), 'issuedAt');
  const expiresAt = validIsoDate(String(input.expiresAt ?? ''), 'expiresAt');
  const issued = Date.parse(issuedAt);
  const expires = Date.parse(expiresAt);
  if (expires <= issued || expires - issued > MAX_TTL_MS) throw new OperatorError('PAIRING_CHALLENGE_INVALID', 'Pairing challenge lifetime is invalid.');
  const expectedPeerDeviceId = input.expectedPeerDeviceId === undefined ? undefined : validUuid(input.expectedPeerDeviceId, 'expectedPeerDeviceId');
  return { version: 1, purpose: PURPOSE, challengeId, issuerDeviceId, issuerFingerprint, nonce, issuedAt, expiresAt, expectedPeerDeviceId };
}

function validateState(input: RegistryState): RegistryState {
  if (!input || typeof input !== 'object' || input.version !== 1 || !Array.isArray(input.devices) || !Array.isArray(input.challenges)) {
    throw new OperatorError('DEVICE_REGISTRY_CORRUPT', 'Device registry structure is invalid.');
  }
  if (input.devices.length > MAX_DEVICES || input.challenges.length > MAX_CHALLENGES) {
    throw new OperatorError('DEVICE_REGISTRY_CORRUPT', 'Device registry exceeds bounded entry limits.');
  }
  const ids = new Set<string>();
  const fingerprints = new Set<string>();
  const devices = input.devices.map((raw) => {
    const peer = normalizePublicIdentity(raw);
    if (ids.has(peer.deviceId) || fingerprints.has(peer.fingerprint)) throw new OperatorError('DEVICE_REGISTRY_CORRUPT', 'Device registry contains duplicate identities.');
    ids.add(peer.deviceId);
    fingerprints.add(peer.fingerprint);
    const status = raw.status === 'revoked' ? 'revoked' : raw.status === 'active' ? 'active' : null;
    if (!status) throw new OperatorError('DEVICE_REGISTRY_CORRUPT', 'Registered device status is invalid.');
    const pairedAt = validIsoDate(String(raw.pairedAt ?? ''), 'pairedAt');
    const revokedAt = raw.revokedAt === undefined ? undefined : validIsoDate(String(raw.revokedAt), 'revokedAt');
    const revokedReason = raw.revokedReason === undefined ? undefined : boundedReason(String(raw.revokedReason));
    if (status === 'active' && revokedAt) throw new OperatorError('DEVICE_REGISTRY_CORRUPT', 'Active device cannot have a revocation timestamp.');
    return { ...peer, status, pairedAt, revokedAt, revokedReason } satisfies RegisteredDevice;
  });
  const challengeIds = new Set<string>();
  const challenges = input.challenges.map((raw) => {
    const challenge = validateChallenge(raw);
    if (challengeIds.has(challenge.challengeId)) throw new OperatorError('DEVICE_REGISTRY_CORRUPT', 'Duplicate pairing challenge ID.');
    challengeIds.add(challenge.challengeId);
    const consumedAt = raw.consumedAt === undefined ? undefined : validIsoDate(String(raw.consumedAt), 'consumedAt');
    return { ...challenge, consumedAt };
  });
  return { version: 1, devices, challenges };
}

function pruneChallenges(state: RegistryState, nowMs: number): void {
  state.challenges = state.challenges.filter((challenge) => {
    const reference = challenge.consumedAt ? Date.parse(challenge.consumedAt) : Date.parse(challenge.expiresAt);
    return nowMs - reference <= CHALLENGE_RETENTION_MS;
  });
}

function boundedTtl(value: number): number {
  if (!Number.isInteger(value) || value < MIN_TTL_MS || value > MAX_TTL_MS) {
    throw new OperatorError('PAIRING_TTL_INVALID', `Pairing TTL must be an integer between ${MIN_TTL_MS} and ${MAX_TTL_MS} ms.`);
  }
  return value;
}

function validUuid(value: string, label: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new OperatorError('DEVICE_IDENTITY_INVALID', `${label} must be a UUID.`);
  }
  return value.toLowerCase();
}

function boundedDeviceName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > DEVICE_NAME_MAX || /[\0\r\n]/.test(trimmed)) throw new OperatorError('DEVICE_IDENTITY_INVALID', 'Device name is invalid.');
  return trimmed;
}

function boundedReason(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > REASON_MAX || /\0/.test(trimmed)) throw new OperatorError('DEVICE_REVOCATION_REASON_INVALID', 'Revocation reason is invalid.');
  return trimmed;
}

function validIsoDate(value: string, label: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) throw new OperatorError('DEVICE_IDENTITY_INVALID', `${label} must be an ISO timestamp.`);
  return value;
}

function publicChallenge(challenge: StoredChallenge): PublicPairingChallenge {
  return {
    version: 1,
    purpose: PURPOSE,
    challengeId: challenge.challengeId,
    issuerDeviceId: challenge.issuerDeviceId,
    issuerFingerprint: challenge.issuerFingerprint,
    nonce: challenge.nonce,
    issuedAt: challenge.issuedAt,
    expiresAt: challenge.expiresAt,
    expectedPeerDeviceId: challenge.expectedPeerDeviceId
  };
}
