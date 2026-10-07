import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CONTRACT_REGISTRY, assertContractRegistryValid } from '../src/core/contract-registry.ts';
import { verifyReleaseTruth } from './verify-release-truth.ts';

const root = path.resolve(import.meta.dirname, '..');
assertContractRegistryValid();
const releaseTruth = await verifyReleaseTruth(root);
const head = git(['rev-parse', 'HEAD']);
const tree = git(['rev-parse', 'HEAD^{tree}']);
const committedAt = git(['show', '-s', '--format=%cI', 'HEAD']);
const outputDir = path.join(root, 'artifacts', 'r1');
await fs.mkdir(outputDir, { recursive: true });

const evidence = {
  schemaVersion: 1,
  kind: 'r1-release-evidence',
  source: {
    repository: 'sampathkumar-co/Operator-runtime',
    head,
    tree,
    committedAt
  },
  releaseTruth,
  contracts: {
    count: CONTRACT_REGISTRY.length,
    digest: sha256(JSON.stringify(CONTRACT_REGISTRY)),
    migrationRange: {
      taskObservationSummary: { previousReadable: 1, current: 2 },
      otherBackwardReadableContracts: 'current-and-explicitly-registered-previous',
      exactContracts: 'current-only'
    }
  },
  deployment: {
    channel: 'release-candidate',
    productionSource: releaseTruth.production.sourceCommit,
    rollbackTarget: releaseTruth.production.sourceCommit,
    productionRuntimeTag: releaseTruth.production.runtimeTag
  },
  packages: {
    mcpServer: await packageVersion('apps/mcp-server/package.json'),
    relayServer: await packageVersion('apps/relay-server/package.json'),
    authPortal: await packageVersion('deploy/auth-portal/package.json'),
    adaptiveIntelligence: await packageVersion('packages/adaptive-intelligence/package.json'),
    mecordConnect: await packageVersion('packages/mecord-connect/package.json'),
    operatorRuntimeCli: await packageVersion('packages/operator-runtime-cli/package.json'),
    verifiedPlanRuntime: await packageVersion('packages/verified-plan-runtime/package.json')
  },
  dependencyLocks: {
    mcpServer: await fileDigest('apps/mcp-server/package-lock.json'),
    relayServer: await fileDigest('apps/relay-server/package-lock.json')
  },
  nativeBoundaries: {
    windowsUia: {
      version: await cargoPackageVersion('native/windows-uia/Cargo.toml'),
      lockDigest: await optionalFileDigest('native/windows-uia/Cargo.lock')
    },
    windowsDpapi: {
      version: await cargoPackageVersion('native/windows-dpapi/Cargo.toml'),
      lockDigest: await optionalFileDigest('native/windows-dpapi/Cargo.lock')
    },
    windowsLauncher: {
      version: await cargoPackageVersion('native/windows-launcher/Cargo.toml'),
      lockDigest: await optionalFileDigest('native/windows-launcher/Cargo.lock')
    }
  },
  containerInputs: {
    authPortalDockerfile: await fileDigest('deploy/auth-portal/Dockerfile'),
    publicEdgeDockerfile: await fileDigest('deploy/public-edge/Dockerfile'),
    publicEdgeGatewayDockerfile: await fileDigest('deploy/public-edge/Dockerfile.gateway'),
    publicEdgeCompose: await fileDigest('deploy/public-edge/compose.yml'),
    sharedVpsComposeExample: await fileDigest('deploy/public-edge/compose.shared-vps.example.yml')
  },
  evidencePolicy: {
    qualificationMustMatchHead: true,
    generatedEvidenceDoesNotByItselfCertifyRelease: true,
    knownLimitations: [
      'Production deployment remains an explicitly promoted state distinct from the source release candidate.'
    ],
    unresolvedFindings: []
  },
  qualification: {
    lane: process.env.R1_QUALIFICATION_LANE ?? 'local',
    workflowRunId: process.env.GITHUB_RUN_ID ?? null,
    workflowSha: process.env.GITHUB_SHA ?? null
  }
};
const canonical = JSON.stringify(evidence, null, 2) + '\n';
const file = path.join(outputDir, 'release-evidence.json');
await fs.writeFile(file, canonical, 'utf8');
await fs.writeFile(path.join(outputDir, 'release-evidence.sha256'), sha256(canonical) + '  release-evidence.json\n', 'utf8');
console.log(`r1-release-evidence:PASS file=${path.relative(root, file)} sha256=${sha256(canonical)}`);

async function packageVersion(relative: string): Promise<{ name: string; version: string | null; private: boolean; manifestDigest: string }> {
  const text = await fs.readFile(path.join(root, relative), 'utf8');
  const parsed = JSON.parse(text) as { name?: unknown; version?: unknown; private?: unknown };
  const name = String(parsed.name ?? '');
  const version = parsed.version === undefined ? null : String(parsed.version);
  if (!name || (version !== null && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version))) {
    throw new Error('Invalid package identity in ' + relative);
  }
  if (version === null && parsed.private !== true) {
    throw new Error('Unversioned package must be explicitly private: ' + relative);
  }
  return { name, version, private: parsed.private === true, manifestDigest: sha256(text) };
}

async function cargoPackageVersion(relative: string): Promise<string> {
  const text = await fs.readFile(path.join(root, relative), 'utf8');
  const packageSection = text.match(/\[package\]([\s\S]*?)(?:\n\[|$)/);
  const version = packageSection?.[1]?.match(/^version\s*=\s*["']([^"']+)["']/m)?.[1];
  if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error('Invalid Cargo package version in ' + relative);
  }
  return version;
}

async function fileDigest(relative: string): Promise<string> {
  const bytes = await fs.readFile(path.join(root, relative));
  return sha256(bytes);
}
async function optionalFileDigest(relative: string): Promise<string | null> {
  try { return await fileDigest(relative); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
function git(args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}
function sha256(input: string | Uint8Array): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}
