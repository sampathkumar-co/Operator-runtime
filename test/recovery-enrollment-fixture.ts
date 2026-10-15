import crypto from 'node:crypto';
import { canonicalJson } from '../src/core/action-identity.ts';
import type { TrustedOriginalDeviceCredential, SignedOwnerEnrollment } from '../apps/local-agent/src/original-recovery-webauthn.ts';

export function independentlySignedTestOwnerEnrollment(
  credential: TrustedOriginalDeviceCredential,
  input: { rpId: string; origin: string; now: number; issuerPrivateKey?: crypto.KeyObject }
): { enrollment: SignedOwnerEnrollment; pinnedIssuerPublicKeyPem: string; issuerPrivateKey: crypto.KeyObject } {
  const issuer = input.issuerPrivateKey ?? crypto.generateKeyPairSync('ed25519').privateKey;
  const payload: SignedOwnerEnrollment['payload'] = {
    version: 1, issuerId: 'offline-trusted-security-administrator',
    rpId: input.rpId, origin: input.origin,
    issuedAt: new Date(input.now - 60_000).toISOString(),
    expiresAt: new Date(input.now + 24 * 60 * 60 * 1000).toISOString(),
    credential
  };
  const signature = crypto.sign(null, Buffer.from(canonicalJson(payload)), issuer).toString('base64url');
  return {
    enrollment: { payload, signature },
    pinnedIssuerPublicKeyPem: crypto.createPublicKey(issuer).export({ format: 'pem', type: 'spki' }).toString(),
    issuerPrivateKey: issuer
  };
}
