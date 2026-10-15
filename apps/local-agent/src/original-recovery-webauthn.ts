import crypto from 'node:crypto';
import type { OperatorRecoveryCandidate } from './operator-pre-dispatch-adjudication.ts';

const MAX_PENDING = 32;
const CHALLENGE_TTL_MS = 90_000;
const HEX_64 = /^[0-9a-f]{64}$/;

/**
 * These credentials MUST be provisioned by an independent, trusted ORIGINAL
 * owner enrollment ceremony. A bearer-authenticated agent must not register,
 * replace, or provide the public keys. No registration API exists here.
 */
export type TrustedOriginalDeviceCredential = {
  credentialId: string; // canonical base64url
  publicKeyPem: string; // trusted ES256 P-256 public key from independently verified enrollment
  deviceId: string;
  deviceFingerprint: string;
  signCount: number;
  deviceBound: true;
};

type Pending = {
  id: string; challenge: string; actionId: string; caseDigest: string;
  deviceId: string; deviceFingerprint: string; credentialId: string;
  deadline: number;
};

export type RecoveryWebAuthnAssertion = {
  id: string;
  response: {
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
  };
};

function decodeCanonical(value: unknown, max = 4096): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > max)
    throw new Error('WEBAUTHN_ENCODING_INVALID');
  const bytes = Buffer.from(value, 'base64url');
  if (!bytes.length || bytes.toString('base64url') !== value) throw new Error('WEBAUTHN_ENCODING_INVALID');
  return bytes;
}

function trustedCredential(input: TrustedOriginalDeviceCredential): boolean {
  if (!input.deviceBound || !/^[A-Za-z0-9_-]{32,96}$/.test(input.deviceFingerprint) ||
      typeof input.deviceId !== 'string' || input.deviceId.length < 4 ||
      !Number.isSafeInteger(input.signCount) || input.signCount < 0) return false;
  try {
    const key = crypto.createPublicKey(input.publicKeyPem);
    return key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1'
      && decodeCanonical(input.credentialId, 512).length <= 128;
  } catch { return false; }
}

export class OriginalRecoveryWebAuthnVerifier {
  readonly rpId: string;
  readonly origin: string;
  readonly deviceId: string;
  readonly deviceFingerprint: string;
  #credential: TrustedOriginalDeviceCredential;
  #pending = new Map<string, Pending>();
  #highestCount: number;
  #clock: () => number;

  constructor(input: {
    rpId: string; origin: string;
    credential: TrustedOriginalDeviceCredential;
    clock?: () => number;
  }) {
    if (!trustedCredential(input.credential) || input.rpId.length > 253 ||
      !/^https:\/\/[^/]+$/.test(input.origin) && !/^http:\/\/localhost(?::\d+)?$/.test(input.origin)) {
      throw new Error('WEBAUTHN_TRUSTED_OWNER_PROVISIONING_REQUIRED');
    }
    const hostname = new URL(input.origin).hostname;
    if (hostname !== input.rpId && !hostname.endsWith('.' + input.rpId)) {
      throw new Error('WEBAUTHN_RP_ORIGIN_MISMATCH');
    }
    this.rpId = input.rpId;
    this.origin = input.origin;
    this.deviceId = input.credential.deviceId;
    this.deviceFingerprint = input.credential.deviceFingerprint;
    this.#credential = structuredClone(input.credential);
    this.#highestCount = input.credential.signCount;
    this.#clock = input.clock ?? (() => Date.now());
  }

  challenge(caseInfo: OperatorRecoveryCandidate): {
    challengeId: string; challenge: string; rpId: string; credentialId: string;
    expiresAt: string; actionId: string; caseDigest: string;
  } {
    if (caseInfo.deviceId !== this.deviceId || caseInfo.deviceFingerprint !== this.deviceFingerprint ||
      !HEX_64.test(caseInfo.caseDigest)) throw new Error('WEBAUTHN_ORIGINAL_DEVICE_MISMATCH');
    for (const [key, p] of this.#pending) if (p.deadline < this.#clock()) this.#pending.delete(key);
    if (this.#pending.size >= MAX_PENDING) throw new Error('WEBAUTHN_TOO_MANY_PENDING');
    const challengeId = crypto.randomUUID();
    const pending: Pending = {
      id: challengeId, challenge: crypto.randomBytes(32).toString('base64url'),
      actionId: caseInfo.actionId, caseDigest: caseInfo.caseDigest,
      deviceId: caseInfo.deviceId, deviceFingerprint: caseInfo.deviceFingerprint,
      credentialId: this.#credential.credentialId, deadline: this.#clock() + CHALLENGE_TTL_MS
    };
    this.#pending.set(challengeId, pending);
    return {
      challengeId, challenge: pending.challenge, rpId: this.rpId,
      credentialId: pending.credentialId,
      expiresAt: new Date(pending.deadline).toISOString(),
      actionId: caseInfo.actionId, caseDigest: caseInfo.caseDigest
    };
  }

  /**
   * One-shot verification. The challenge is destroyed before parsing or
   * signature verification, including malformed, expired and replayed claims.
   * External enrollment is essential; this class cannot grant user authority.
   */
  verifyAndConsume(input: {
    challengeId: string; actionId: string; caseDigest: string;
    assertion: RecoveryWebAuthnAssertion;
  }): void {
    const pending = this.#pending.get(input.challengeId);
    this.#pending.delete(input.challengeId);
    if (!pending || this.#clock() >= pending.deadline ||
        input.actionId !== pending.actionId || input.caseDigest !== pending.caseDigest ||
        pending.deviceId !== this.deviceId || pending.deviceFingerprint !== this.deviceFingerprint) {
      throw new Error('WEBAUTHN_CHALLENGE_INVALID_OR_EXPIRED');
    }
    const a = input.assertion;
    if (!a || typeof a !== 'object' || a.id !== pending.credentialId ||
        !a.response || typeof a.response !== 'object') throw new Error('WEBAUTHN_CREDENTIAL_MISMATCH');
    const clientDataBytes = decodeCanonical(a.response.clientDataJSON, 16 * 1024);
    const authenticatorData = decodeCanonical(a.response.authenticatorData, 4096);
    const signature = decodeCanonical(a.response.signature, 4096);
    if (authenticatorData.length < 37 || authenticatorData.length > 1024) throw new Error('WEBAUTHN_AUTHENTICATOR_INVALID');
    let clientData: Record<string, unknown>;
    try { clientData = JSON.parse(clientDataBytes.toString('utf8')); }
    catch { throw new Error('WEBAUTHN_CLIENT_DATA_INVALID'); }
    if (!clientData || clientData.type !== 'webauthn.get' ||
      clientData.challenge !== pending.challenge || clientData.origin !== this.origin ||
      clientData.crossOrigin === true || clientData.topOrigin !== undefined) {
      throw new Error('WEBAUTHN_CLIENT_DATA_MISMATCH');
    }
    const rpHash = crypto.createHash('sha256').update(this.rpId, 'utf8').digest();
    if (!crypto.timingSafeEqual(authenticatorData.subarray(0, 32), rpHash))
      throw new Error('WEBAUTHN_RP_MISMATCH');
    const flags = authenticatorData[32]!;
    // Require UP + UV, reject BE (syncable/passkey backup eligibility) and
    // AT (credential-creation metadata in a login assertion).
    if ((flags & 0x05) !== 0x05 || (flags & 0x08) !== 0 || (flags & 0x40) !== 0) {
      throw new Error('WEBAUTHN_USER_VERIFICATION_OR_DEVICE_BOUND_PROOF_MISSING');
    }
    const signCount = authenticatorData.readUInt32BE(33);
    if (this.#highestCount && (!signCount || signCount <= this.#highestCount)) {
      throw new Error('WEBAUTHN_SIGN_COUNTER_REPLAY');
    }
    const signed = Buffer.concat([
      authenticatorData,
      crypto.createHash('sha256').update(clientDataBytes).digest()
    ]);
    if (!crypto.verify('sha256', signed, this.#credential.publicKeyPem, signature)) {
      throw new Error('WEBAUTHN_SIGNATURE_INVALID');
    }
    if (signCount) this.#highestCount = signCount;
  }
}
