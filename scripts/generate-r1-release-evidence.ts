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
    digest: sha256(JSON.stringify(CONTRACT_REGISTRY))
  },
  dependencyLocks: {
    mcpServer: await fileDigest('apps/mcp-server/package-lock.json'),
    relayServer: await fileDigest('apps/relay-server/package-lock.json')
  },
  nativeBoundaries: {
    windowsUia: await optionalFileDigest('native/windows-uia/Cargo.lock'),
    windowsDpapi: await optionalFileDigest('native/windows-dpapi/Cargo.lock'),
    windowsLauncher: await optionalFileDigest('native/windows-launcher/Cargo.lock')
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
