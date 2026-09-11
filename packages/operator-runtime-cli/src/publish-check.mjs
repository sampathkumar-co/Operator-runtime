import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_MANIFEST_URL,
  fetchReleaseMetadata,
  validatePackageReleaseVersion,
  validateTrustedSigners
} from './release.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const trust = JSON.parse(await fs.readFile(path.join(root, 'trusted-signers.json'), 'utf8'));
const signers = validateTrustedSigners(trust);

if (pkg.name !== 'operator-runtime-cli') throw new Error('Unexpected npm package name.');
if (signers.length === 0) throw new Error('Refusing npm publish: no production Windows signer is pinned.');

const releaseVersion = String(process.env.OPERATOR_RELEASE_VERSION ?? '').trim();
const binding = validatePackageReleaseVersion(pkg.version, releaseVersion);
const metadata = await fetchReleaseMetadata(DEFAULT_MANIFEST_URL);
if (metadata.version !== binding.releaseVersion) {
  throw new Error(`Refusing npm publish: latest production release is ${metadata.version}, expected ${binding.releaseVersion}.`);
}
const matchingSigners = signers.filter((entry) =>
  entry.subject === metadata.signerSubject &&
  entry.certificateSha256 === metadata.signerCertificateSha256
);
if (matchingSigners.length !== 1) {
  throw new Error('Refusing npm publish: latest production release signer is not pinned exactly once.');
}

console.log(`operator-runtime-cli publish check: PASS (${binding.packageVersion} -> ${binding.releaseVersion}, production release signer pinned)`);
