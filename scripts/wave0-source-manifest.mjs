import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const STABLE_RELEASE_COMMIT = 'b9682da964b8dfcda9b4ce65e1ba6352623bf7a5';
export const SOURCE_FILES = Object.freeze([
  'package.json',
  'packages/mecord-connect/package.json',
  'packages/mecord-connect/bin/operator.mjs',
  'apps/local-agent/src/runtime-factory.ts',
  'apps/mcp-server/src/public-tools.ts',
  'src/core/runtime.ts',
  'src/core/public-plugin-surface.ts',
  'src/core/evaluation.ts',
  'src/core/agent-kernel.ts',
  'src/core/policy.ts',
  'native/windows-path-lease/Program.cs',
  'native/windows-uia/Cargo.toml',
  '.github/workflows/ci.yml',
  '.github/workflows/platform-matrix.yml',
  '.github/workflows/windows-signing-smoke.yml',
  '.github/workflows/npm-remote-ci.yml'
]);

export function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}
export function extractProviderNames(factorySource) {
  const names = [...factorySource.matchAll(/\.register\(new\s+(\w+Provider)\s*\(/g)].map(m => m[1]);
  if (names.length < 10) throw new Error('Runtime provider inventory incomplete: less than ten registered providers.');
  return [...new Set(names)].sort();
}
export function extractPublicTools(source) {
  const section = source.match(/PUBLIC_PLUGIN_TOOL_NAMES\s*=\s*Object\.freeze\(\[([\s\S]*?)\]\s*\.sort\(\)\)/);
  if (!section) throw new Error('Public nine-tool contract not found.');
  const tools = [...section[1].matchAll(/'([^']+)'/g)].map(m => m[1]).sort();
  if (tools.length !== 9 || new Set(tools).size !== 9) {
    throw new Error('Expected exactly nine unique declared public MCP tools.');
  }
  return tools;
}

/** Only source-file hashes are certified here. An npm registry tarball, executed
 * native helper or hosted deployment requires separate physical/registry proof. */
export function buildSourceProvenance(input) {
  const fullSha = /^[0-9a-f]{40}$/;
  if (!fullSha.test(input.releaseCommit) || !fullSha.test(input.candidateCommit)) {
    throw new Error('Source and baseline identities must be immutable full commit SHA values.');
  }
  if (!input.clean) throw new Error('Source provenance cannot be frozen from a dirty checkout.');
  if (!input.releaseFiles || !input.candidateFiles) throw new Error('Source file map missing.');
  for (const file of SOURCE_FILES) {
    if (!Buffer.isBuffer(input.releaseFiles[file]) || !Buffer.isBuffer(input.candidateFiles[file])) {
      throw new Error(`Missing pinned file bytes: ${file}`);
    }
  }
  const stablePkg = JSON.parse(input.releaseFiles['packages/mecord-connect/package.json'].toString('utf8'));
  const candidatePkg = JSON.parse(input.candidateFiles['packages/mecord-connect/package.json'].toString('utf8'));
  if (stablePkg.name !== 'mecord-connect' || stablePkg.version !== '2.0.6') {
    throw new Error('Pinned release does not contain the declared mecord-connect 2.0.6 package.');
  }
  if (candidatePkg.name !== stablePkg.name) throw new Error('Candidate package identity changed.');
  const publicTools = extractPublicTools(input.releaseFiles['src/core/public-plugin-surface.ts'].toString('utf8'));
  const candidateTools = extractPublicTools(input.candidateFiles['src/core/public-plugin-surface.ts'].toString('utf8'));
  if (JSON.stringify(publicTools) !== JSON.stringify(candidateTools)) {
    throw new Error('Public nine-tool surface differs from frozen baseline; explicit compatibility review required.');
  }
  const providerNames = extractProviderNames(input.candidateFiles['apps/local-agent/src/runtime-factory.ts'].toString('utf8'));
  const fileHashes = Object.fromEntries(SOURCE_FILES.map(file => [file, {
    releaseSourceSha256: sha256(input.releaseFiles[file]),
    candidateSourceSha256: sha256(input.candidateFiles[file])
  }]));
  return {
    schemaVersion: 1,
    release: { package: stablePkg.name, version: stablePkg.version, commit: input.releaseCommit,
      npmRegistryTarball: { status: 'NOT_VERIFIED', sha256: null },
      installedWindowsDoctor: { status: 'NOT_RUN_IN_THIS_CI', evidence: null },
      compiledNativeHelpers: { status: 'NOT_VERIFIED', hashes: null },
      hostedDeployment: { status: 'NOT_VERIFIED', commit: null } },
    candidate: { commit: input.candidateCommit, packageVersion: candidatePkg.version, checkoutClean: true },
    source: { sha256: fileHashes, providerRegistrations: providerNames,
      providerRiskVerification: 'NOT_ASSESSED_PER_OPERATION',
      publicSurfaceVersion: 1, publicTools },
    environment: { node: input.nodeVersion, os: input.platform,
      browser: { status: 'NOT_RUN', version: null }, model: { status: 'NOT_RUN', name: null },
      physicalWindows: 'NOT_RUN', twoHost: 'NOT_RUN' },
    evaluations: { laneA: 'NOT_RUN', laneB: 'NOT_RUN', laneC: 'NOT_RUN', full125MiniWob: 'NOT_RUN' },
    limits: [
      'Source hashes do not prove the published npm artifact matches the source.',
      'Native source manifests do not prove executable helper bytes or physical Windows behavior.',
      'Registered provider classes are not per-action contract certification.',
      'No model, browser version or benchmark run is inferred from a green CI checkout.'
    ]
  };
}
function git(...args) {
  return execFileSync('git', args, { maxBuffer: 12 * 1024 * 1024 });
}
function pinnedFile(ref, file) {
  return git('show', `${ref}:${file}`);
}
export function generateCurrentSourceProvenance() {
  const commit = git('rev-parse', 'HEAD').toString('utf8').trim().toLowerCase();
  const clean = git('status', '--porcelain', '--untracked-files=normal').toString('utf8').trim() === '';
  const releaseFiles = Object.fromEntries(SOURCE_FILES.map(file => [file, pinnedFile(STABLE_RELEASE_COMMIT, file)]));
  const candidateFiles = Object.fromEntries(SOURCE_FILES.map(file => [file, pinnedFile(commit, file)]));
  return buildSourceProvenance({
    releaseCommit: STABLE_RELEASE_COMMIT, candidateCommit: commit, clean,
    releaseFiles, candidateFiles, nodeVersion: process.version, platform: process.platform
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const result = generateCurrentSourceProvenance();
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
