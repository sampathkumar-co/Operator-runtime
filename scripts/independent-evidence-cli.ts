import fs from 'node:fs/promises';
import path from 'node:path';
import type { IndependentCampaignEvidence } from '../src/core/independent-campaign-evidence.ts';

const MAX_EVIDENCE_MANIFEST_BYTES = 90 * 1024 * 1024;
const VERIFIER_ID = /^[A-Za-z0-9._:@/+-]{1,512}$/;

/**
 * Trust roots are loaded from an operator-selected PEM path, never from the
 * untrusted campaign or evidence bundle. No flags => scoring-only.
 */
export async function loadIndependentEvidenceCli(
  flags: readonly string[]
): Promise<IndependentCampaignEvidence | undefined> {
  if (flags.length === 0) return undefined;
  if (flags.length !== 6 || flags[0] !== '--evidence' ||
      flags[2] !== '--verifier-id' || flags[4] !== '--trusted-public-key') {
    throw new Error('Expected: --evidence <artifact-bundle.json> --verifier-id <id> --trusted-public-key <operator-controlled.pem>');
  }
  const bundlePath = path.resolve(flags[1]!);
  const verifierId = flags[3]!;
  const trustedKeyPath = path.resolve(flags[5]!);
  if (!VERIFIER_ID.test(verifierId)) throw new Error('Verifier identity is invalid.');
  if (bundlePath === trustedKeyPath) throw new Error('Independent evidence and release trust root cannot use the same file.');

  const [bundleStat, keyStat] = await Promise.all([fs.stat(bundlePath), fs.stat(trustedKeyPath)]);
  if (!bundleStat.isFile() || bundleStat.size > MAX_EVIDENCE_MANIFEST_BYTES ||
      !keyStat.isFile() || keyStat.size < 64 || keyStat.size > 8192) {
    throw new Error('Evidence bundle or independent release trust root is invalid or oversized.');
  }
  const raw = JSON.parse(await fs.readFile(bundlePath, 'utf8')) as Record<string, unknown>;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.hasOwn(raw,'trustedVerifierPublicKeys')) {
    throw new Error('Evidence bundle must not supply or override trusted verifier public keys.');
  }
  if (!raw.attestation || typeof raw.attestation !== 'object' ||
      (raw.attestation as { verifierId?: unknown }).verifierId !== verifierId ||
      !Array.isArray(raw.artifacts)) {
    throw new Error('Evidence bundle is malformed or signed by a different verifier.');
  }
  const keyPem = await fs.readFile(trustedKeyPath, 'utf8');
  const trustedVerifierPublicKeys: Record<string, string> = Object.create(null);
  trustedVerifierPublicKeys[verifierId] = keyPem;
  return {
    trustedVerifierPublicKeys,
    attestation: raw.attestation as IndependentCampaignEvidence['attestation'],
    artifacts: raw.artifacts as IndependentCampaignEvidence['artifacts']
  };
}
