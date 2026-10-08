import crypto from 'node:crypto';
import { canonicalJson } from './action-identity.ts';

/**
 * Out-of-band trust roots must be supplied by the release operator, never by
 * the campaign whose claims are being certified. This validates provenance
 * and byte integrity, not whether an independent verifier was truthful.
 */
export interface IndependentCampaignEvidence {
  trustedVerifierPublicKeys: Readonly<Record<string, string>>;
  attestation: {
    schemaVersion: 1;
    campaignDigest: string;
    verifierId: string;
    artifactDigests: string[];
    signatureBase64: string;
  };
  artifacts: ReadonlyArray<{ digest: string; contentBase64: string }>;
}

const SHA256 = /^[0-9a-f]{64}$/;
const MAX_ARTIFACTS = 20_000;
const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_ARTIFACT_BYTES = 64 * 1024 * 1024;
const VERIFIER_ID = /^[A-Za-z0-9._:@/+-]{1,512}$/;

function canonicalDigests(input: readonly string[]): string[] {
  if (!Array.isArray(input) || input.length > MAX_ARTIFACTS) throw new Error('Artifact digest list exceeds the bound.');
  const digests = input.map((value) => {
    if (typeof value !== 'string' || !SHA256.test(value)) throw new Error('Artifact digest is invalid.');
    return value;
  });
  if (new Set(digests).size !== digests.length) throw new Error('Duplicate artifact digest.');
  return [...digests].sort();
}

/** Stable, domain-separated bytes for an external Ed25519 verifier to sign. */
export function independentCampaignEvidencePayload(
  campaignDigest: string,
  verifierId: string,
  artifactDigests: readonly string[]
): Buffer {
  if (!SHA256.test(campaignDigest) || !VERIFIER_ID.test(verifierId)) throw new Error('Campaign or verifier identity is invalid.');
  return Buffer.from(
    'mecord-independent-campaign-evidence-v1\n' +
    canonicalJson({ schemaVersion: 1, campaignDigest, verifierId, artifactDigests: canonicalDigests(artifactDigests) }),
    'utf8'
  );
}

function strictBase64(input: unknown, maxBytes: number): Buffer | undefined {
  if (typeof input !== 'string' || input.length > Math.ceil(maxBytes / 3) * 4 + 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input)) return undefined;
  const decoded = Buffer.from(input, 'base64');
  if (decoded.length > maxBytes || decoded.toString('base64') !== input) return undefined;
  return decoded;
}

/**
 * Rejects unsigned/self-attested claims and unverified digest strings.
 * The signed campaign digest binds every claimed observation and prior-release
 * claim to an explicitly pinned external verifier identity.
 */
export function verifyIndependentCampaignEvidence(
  campaignDigest: string,
  requiredEvidenceDigests: readonly string[],
  executorIds: readonly string[],
  verifierIds: readonly string[],
  trust?: IndependentCampaignEvidence
): string[] {
  if (!trust) return ['independent verifier evidence attestation is missing'];
  try {
    const attestation = trust.attestation;
    if (!attestation || attestation.schemaVersion !== 1 || attestation.campaignDigest !== campaignDigest) {
      throw new Error('independent attestation is not bound to this campaign');
    }
    if (!verifierIds.includes(attestation.verifierId) || executorIds.includes(attestation.verifierId)) {
      throw new Error('independent attestation signer is not a separated campaign verifier');
    }
    // Object.hasOwn rejects inherited key entries. A campaign-supplied key
    // must never be accepted as the release operator's trust root.
    if (!trust.trustedVerifierPublicKeys || !Object.hasOwn(trust.trustedVerifierPublicKeys, attestation.verifierId)) {
      throw new Error('independent attestation signer is not in the release trust store');
    }
    const keyPem = trust.trustedVerifierPublicKeys[attestation.verifierId];
    if (typeof keyPem !== 'string') throw new Error('independent verifier key is invalid');
    const key = crypto.createPublicKey(keyPem);
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('independent verifier must use an Ed25519 signing key');

    const signedDigests = canonicalDigests(attestation.artifactDigests);
    if (signedDigests.length !== attestation.artifactDigests.length ||
        signedDigests.some((item, i) => item !== attestation.artifactDigests[i])) {
      throw new Error('signed artifact manifest must be sorted and unique');
    }
    const signature = strictBase64(attestation.signatureBase64, 64);
    if (!signature || signature.length !== 64 ||
        !crypto.verify(null, independentCampaignEvidencePayload(campaignDigest, attestation.verifierId, signedDigests), key, signature)) {
      throw new Error('independent verifier attestation signature is invalid');
    }

    if (!Array.isArray(trust.artifacts) || trust.artifacts.length !== signedDigests.length || trust.artifacts.length > MAX_ARTIFACTS) {
      throw new Error('evidence artifact count does not match signed manifest');
    }
    const verified = new Set<string>();
    let totalBytes = 0;
    for (const artifact of trust.artifacts) {
      if (!artifact || typeof artifact.digest !== 'string' || !SHA256.test(artifact.digest) || verified.has(artifact.digest)) {
        throw new Error('evidence artifact identity is invalid or duplicated');
      }
      const bytes = strictBase64(artifact.contentBase64, MAX_ARTIFACT_BYTES);
      if (!bytes) throw new Error('evidence artifact bytes are missing, oversized, or malformed');
      totalBytes += bytes.length;
      if (totalBytes > MAX_TOTAL_ARTIFACT_BYTES) throw new Error('independent evidence exceeds the aggregate size limit');
      const actual = crypto.createHash('sha256').update(bytes).digest('hex');
      if (actual !== artifact.digest) throw new Error('evidence artifact bytes do not match claimed digest');
      verified.add(artifact.digest);
    }
    if (signedDigests.some((item) => !verified.has(item))) throw new Error('signed evidence artifact is missing');
    if (requiredEvidenceDigests.some((item) => !verified.has(item))) {
      throw new Error('campaign references evidence whose actual bytes have not been independently authenticated');
    }
    return [];
  } catch (error) {
    return [(error as Error).message || 'independent evidence verification failed'];
  }
}
