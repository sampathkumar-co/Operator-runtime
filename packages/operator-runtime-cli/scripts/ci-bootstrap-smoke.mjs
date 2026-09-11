import fs from 'node:fs/promises';
import path from 'node:path';
import { bootstrapLocalReleaseForCi, verifyInstalledRelease } from '../src/cli.mjs';

const [metadataPath, artifactPath, signerSubject, signerSha256, root] = process.argv.slice(2);
if (![metadataPath, artifactPath, signerSubject, signerSha256, root].every(Boolean)) {
  throw new Error('Usage: ci-bootstrap-smoke.mjs <metadata> <artifact> <signer-subject> <signer-sha256> <root>');
}

const state = path.join(process.env.LOCALAPPDATA, 'Operator');
await fs.mkdir(root, { recursive: true });
await fs.rm(state, { recursive: true, force: true });
const trustedSigners = [{ subject: signerSubject, certificateSha256: signerSha256.toLowerCase() }];
const watchdog = setTimeout(() => {
  console.error('[operator-bootstrap-phase] watchdog:timeout after 180000ms');
  process.exit(124);
}, 180_000);
try {
  const onPhase = (phase) => console.log(`[operator-bootstrap-phase] ${phase}`);
  const result = await bootstrapLocalReleaseForCi({ root, metadataPath, artifactPath, trustedSigners, onPhase });
  onPhase('installed-release-verify:start');
  await verifyInstalledRelease(trustedSigners);
  onPhase('installed-release-verify:ok');
  if (!result.installed?.installLocation) throw new Error('Bootstrap did not return installed package location.');
  console.log('operator-npx-bootstrap-smoke:ok');
} finally {
  clearTimeout(watchdog);
}
