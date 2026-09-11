import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_MANIFEST_URL,
  downloadAndVerifyArtifact,
  fetchReleaseMetadata,
  loadTrustedSigners,
  validateReleaseMetadata,
  verifyLocalArtifact
} from './release.mjs';
import {
  assertSupportedWindows,
  getInstalledOperatorPackage,
  installVerifiedMsix,
  requireSignatureMatchesMetadata,
  requireTrustedSigner,
  runOperatorSetup,
  runOperatorVerify,
  verifyAuthenticode,
  verifyInstalledOperatorSignature
} from './windows.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const trustedSignersFile = path.join(packageRoot, 'trusted-signers.json');

function usage() {
  return `Operator Runtime bootstrap

Usage:
  npx operator-runtime-cli setup [--root <folder>] [--manifest <https-url>]
  npx operator-runtime-cli verify
  npx operator-runtime-cli --help

Default manifest:
  ${DEFAULT_MANIFEST_URL}

The bootstrap refuses unsigned, untimestamped, hash-mismatched, or unpinned Windows packages.`;
}

function parseArgs(argv) {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') return { command: 'help' };
  if (argv[0] === 'verify') {
    if (argv.length !== 1) throw new Error('verify does not accept additional arguments.');
    return { command: 'verify' };
  }
  if (argv[0] !== 'setup') throw new Error(`Unknown command '${argv[0]}'. Use --help.`);
  let root = process.cwd();
  let manifest = DEFAULT_MANIFEST_URL;
  for (let i = 1; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag !== '--root' && flag !== '--manifest') throw new Error(`Unknown setup option '${flag}'.`);
    const value = argv[++i];
    if (!value) throw new Error(`${flag} requires a value.`);
    if (flag === '--root') root = value;
    else manifest = value;
  }
  return { command: 'setup', root, manifest };
}

async function assertRootDirectory(root) {
  const resolved = path.resolve(root);
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat?.isDirectory()) throw new Error(`Authorized root is not a directory: ${resolved}`);
  return await fs.realpath(resolved);
}

async function trustedProductionSigners() {
  const signers = await loadTrustedSigners(trustedSignersFile);
  if (signers.length === 0) {
    throw new Error(
      'No production signing certificate is pinned in this bootstrap version. ' +
      'Do not install an unsigned or unpinned build; publish a new CLI after the production signer is provisioned.'
    );
  }
  return signers;
}

export async function bootstrapRemoteRelease({ root, manifestUrl = DEFAULT_MANIFEST_URL, trustedSigners } = {}) {
  assertSupportedWindows();
  const authorizedRoot = await assertRootDirectory(root ?? process.cwd());
  const signers = trustedSigners ?? await trustedProductionSigners();
  const metadata = await fetchReleaseMetadata(manifestUrl);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-bootstrap-'));
  const msix = path.join(temp, metadata.artifact);
  try {
    console.log(`[operator] release ${metadata.version}`);
    console.log('[operator] downloading signed Windows package...');
    await downloadAndVerifyArtifact(metadata, manifestUrl, msix);
    const signature = await verifyAuthenticode(msix);
    requireSignatureMatchesMetadata(signature, metadata);
    requireTrustedSigner(signature, signers);
    console.log(`[operator] verified signer: ${signature.subject}`);
    const installed = await installVerifiedMsix(msix, metadata, signature);
    console.log(installed.installedNow ? '[operator] package installed.' : '[operator] matching package already installed.');
    await runOperatorSetup(installed, authorizedRoot);
    console.log('[operator] ready. Connect Operator in ChatGPT.');
    return { metadata, signature, installed, authorizedRoot };
  } finally {
    await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
  }
}

export async function bootstrapLocalReleaseForCi({ root, metadataPath, artifactPath, trustedSigners }) {
  assertSupportedWindows();
  const authorizedRoot = await assertRootDirectory(root);
  const raw = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
  const metadata = validateReleaseMetadata(raw, { allowUntimestamped: true });
  await verifyLocalArtifact(metadata, artifactPath);
  const signature = await verifyAuthenticode(artifactPath);
  requireSignatureMatchesMetadata(signature, metadata);
  requireTrustedSigner(signature, trustedSigners);
  const installed = await installVerifiedMsix(artifactPath, metadata, signature);
  await runOperatorSetup(installed, authorizedRoot);
  await runOperatorVerify(installed);
  return { metadata, signature, installed, authorizedRoot };
}

export async function verifyInstalledRelease(trustedSigners) {
  assertSupportedWindows();
  const installed = await getInstalledOperatorPackage();
  if (!installed) throw new Error('Operator.Runtime is not installed. Run setup first.');
  const signers = trustedSigners ?? await trustedProductionSigners();
  const signature = await verifyInstalledOperatorSignature(installed);
  requireTrustedSigner(signature, signers);
  await runOperatorVerify(installed);
  return { installed, signature };
}

export async function main(argv) {
  const args = parseArgs(argv);
  if (args.command === 'help') {
    console.log(usage());
    return;
  }
  assertSupportedWindows();
  if (args.command === 'verify') {
    await verifyInstalledRelease();
    return;
  }
  await bootstrapRemoteRelease({ root: args.root, manifestUrl: args.manifest });
}
