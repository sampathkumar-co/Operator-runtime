import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { RELEASE_TRUTH } from '../src/core/release-truth.ts';

interface ReleaseState {
  schemaVersion?: number;
  statusDate?: string;
  production?: {
    sourceCommit?: string;
    publicMcp?: string;
    developerMcp?: string;
  };
  versions?: {
    publicProduct?: string;
    runtimePackage?: string;
    runtimeTag?: string;
  };
}

interface PackageManifest {
  name?: string;
  version?: string;
}

export interface ReleaseTruthEvidence {
  schemaVersion: number;
  source: {
    repository: string;
    headCommit: string | null;
    publicSurfaceVersion: string;
    runtimePackageVersion: string;
    bootstrapPackageVersion: string;
  };
  production: {
    statusDate: string;
    sourceCommit: string;
    publicSurfaceVersion: string;
    runtimePackageVersion: string;
    runtimeTag: string;
    publicMcp: string;
    developerMcp: string;
  };
}

function fail(message: string): never {
  throw new Error(message);
}

function requireSemver(value: unknown, label: string): string {
  const text = String(value ?? '').trim();
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(text)) {
    fail(`${label} must be valid SemVer.`);
  }
  return text;
}

function requireSha(value: unknown, label: string): string {
  const text = String(value ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(text)) fail(`${label} must be a full 40-character Git SHA.`);
  return text;
}

function requireHttps(value: unknown, label: string): string {
  const text = String(value ?? '').trim();
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    fail(`${label} must be an absolute HTTPS URL.`);
  }
  if (parsed!.protocol !== 'https:' || !parsed!.hostname || parsed!.username || parsed!.password) {
    fail(`${label} must be an absolute HTTPS URL without embedded credentials.`);
  }
  return parsed!.href.replace(/\/$/, '');
}

function requireEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) fail(`${label} mismatch: expected ${String(expected)}, got ${String(actual)}.`);
}

export function validateReleaseTruthEvidence(input: {
  runtimeManifest: PackageManifest;
  bootstrapManifest: PackageManifest;
  releaseState: ReleaseState;
  headCommit?: string | null;
}): ReleaseTruthEvidence {
  const runtimeVersion = requireSemver(input.runtimeManifest.version, 'mecord-connect package version');
  const bootstrapVersion = requireSemver(input.bootstrapManifest.version, 'operator-runtime-cli package version');
  const publicVersion = requireSemver(RELEASE_TRUTH.product.publicSurfaceVersion, 'public surface version');
  const productionRuntimeVersion = requireSemver(RELEASE_TRUTH.production.runtimePackageVersion, 'production runtime package version');
  const productionSource = requireSha(RELEASE_TRUTH.production.sourceCommit, 'production source commit');
  const publicMcp = requireHttps(RELEASE_TRUTH.production.publicMcp, 'production public MCP');
  const developerMcp = requireHttps(RELEASE_TRUTH.production.developerMcp, 'production developer MCP');

  requireEqual(input.runtimeManifest.name, RELEASE_TRUTH.product.name, 'runtime package name');
  requireEqual(runtimeVersion, RELEASE_TRUTH.source.runtimePackageVersion, 'source runtime package version');
  requireEqual(bootstrapVersion, RELEASE_TRUTH.source.bootstrapPackageVersion, 'source bootstrap package version');

  const recordedProductionSource = requireSha(input.releaseState.production?.sourceCommit, 'recorded production source commit');
  const recordedPublicMcp = requireHttps(input.releaseState.production?.publicMcp, 'recorded production public MCP');
  const recordedDeveloperMcp = requireHttps(input.releaseState.production?.developerMcp, 'recorded production developer MCP');
  const recordedPublicVersion = requireSemver(input.releaseState.versions?.publicProduct, 'recorded production public surface version');
  const recordedRuntimeVersion = requireSemver(input.releaseState.versions?.runtimePackage, 'recorded production runtime package version');

  requireEqual(input.releaseState.statusDate, RELEASE_TRUTH.production.statusDate, 'production status date');
  requireEqual(recordedProductionSource, productionSource, 'production source commit');
  requireEqual(recordedPublicMcp, publicMcp, 'production public MCP');
  requireEqual(recordedDeveloperMcp, developerMcp, 'production developer MCP');
  requireEqual(recordedPublicVersion, publicVersion, 'production public surface version');
  requireEqual(recordedRuntimeVersion, productionRuntimeVersion, 'production runtime package version');
  requireEqual(input.releaseState.versions?.runtimeTag, RELEASE_TRUTH.production.runtimeTag, 'production runtime tag');

  const headCommit = input.headCommit === undefined || input.headCommit === null
    ? null
    : requireSha(input.headCommit, 'source HEAD');

  return {
    schemaVersion: RELEASE_TRUTH.schemaVersion,
    source: {
      repository: RELEASE_TRUTH.source.repository,
      headCommit,
      publicSurfaceVersion: publicVersion,
      runtimePackageVersion: runtimeVersion,
      bootstrapPackageVersion: bootstrapVersion
    },
    production: {
      statusDate: RELEASE_TRUTH.production.statusDate,
      sourceCommit: productionSource,
      publicSurfaceVersion: publicVersion,
      runtimePackageVersion: productionRuntimeVersion,
      runtimeTag: RELEASE_TRUTH.production.runtimeTag,
      publicMcp,
      developerMcp
    }
  };
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as T;
}

function readHead(root: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

export async function verifyReleaseTruth(root = path.resolve(import.meta.dirname, '..')): Promise<ReleaseTruthEvidence> {
  const [runtimeManifest, bootstrapManifest, releaseState] = await Promise.all([
    readJson<PackageManifest>(path.join(root, 'packages', 'mecord-connect', 'package.json')),
    readJson<PackageManifest>(path.join(root, 'packages', 'operator-runtime-cli', 'package.json')),
    readJson<ReleaseState>(path.join(root, 'docs', 'release-state.json'))
  ]);
  return validateReleaseTruthEvidence({
    runtimeManifest,
    bootstrapManifest,
    releaseState,
    headCommit: readHead(root)
  });
}

const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (isEntrypoint) {
  const evidence = await verifyReleaseTruth();
  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify(evidence, null, 2) + '\n');
  } else {
    const deployedMatchesSource = evidence.source.headCommit === evidence.production.sourceCommit;
    console.log(`release-truth:PASS source_runtime=${evidence.source.runtimePackageVersion} production_runtime=${evidence.production.runtimePackageVersion} production_source=${evidence.production.sourceCommit} current_head=${evidence.source.headCommit ?? 'unknown'} deployed_head_match=${deployedMatchesSource ? 'yes' : 'no'}`);
  }
}
