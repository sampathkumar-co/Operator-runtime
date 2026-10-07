import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { CONTRACT_REGISTRY, assertContractRegistryValid, contractReadCompatibility } from '../src/core/contract-registry.ts';

const REQUIRED_CONTRACTS = [
  'principal',
  'delegation',
  'intent-binding',
  'goal',
  'durable-task-plan',
  'plan-revision',
  'plan-node',
  'task-capsule',
  'action-request',
  'action-attempt',
  'authority-envelope',
  'resource-identity',
  'resource-revision',
  'resource-lease',
  'fence-token',
  'evidence',
  'verification-receipt',
  'artifact-record',
  'event',
  'evaluation-run',
  'execution-context-identity'
] as const;

test('R1 contract registry covers canonical execution identities and envelopes', () => {
  assert.doesNotThrow(() => assertContractRegistryValid());
  const names = new Set(CONTRACT_REGISTRY.map((item) => item.name));
  for (const name of REQUIRED_CONTRACTS) assert.equal(names.has(name), true, `missing canonical contract: ${name}`);
});

test('R1 root workspace declares every package-bearing production boundary without shadowing nested release locks', async () => {
  const manifest = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
    workspaces?: string[];
    mecordWorkspaceLayout?: string;
    scripts?: Record<string, string>;
  };
  const layout = JSON.parse(await fs.readFile(new URL('../workspace-layout.json', import.meta.url), 'utf8')) as {
    strategy?: string;
    packages?: Array<{ path: string; lockfile: string | null }>;
    invariants?: Record<string, boolean>;
  };
  assert.equal(manifest.workspaces, undefined);
  assert.equal(manifest.mecordWorkspaceLayout, './workspace-layout.json');
  assert.equal(layout.strategy, 'independently-locked-packages');
  assert.deepEqual(layout.packages?.map((item) => item.path), [
    'apps/mcp-server',
    'apps/relay-server',
    'deploy/auth-portal',
    'packages/adaptive-intelligence',
    'packages/mecord-connect',
    'packages/mecord-capability-sdk',
    'packages/operator-runtime-cli',
    'packages/verified-plan-runtime'
  ]);
  assert.equal(layout.invariants?.nestedReleaseLocksRemainAuthoritative, true);
  assert.equal(layout.invariants?.rootNpmWorkspacesDisabledToPreventLockfileShadowing, true);
  assert.equal(typeof manifest.scripts?.['typecheck:production'], 'string');
  assert.equal(typeof manifest.scripts?.['verify:r1-source'], 'string');
  assert.equal(typeof manifest.scripts?.['evidence:r1'], 'string');
});

test('R1 production TypeScript config is strict and spans all runtime sources', async () => {
  const config = JSON.parse(await fs.readFile(new URL('../tsconfig.production.json', import.meta.url), 'utf8')) as {
    compilerOptions?: Record<string, unknown>;
    include?: string[];
  };
  assert.equal(config.compilerOptions?.strict, true);
  assert.equal(config.compilerOptions?.noEmit, true);
  for (const required of [
    'src/**/*.ts',
    'apps/local-agent/src/**/*.ts',
    'apps/mcp-server/src/**/*.ts',
    'apps/relay-server/src/**/*.ts',
    'packages/adaptive-intelligence/src/**/*.ts',
    'packages/verified-plan-runtime/src/**/*.ts'
  ]) assert.equal(config.include?.includes(required), true, `missing typecheck boundary: ${required}`);
});

test('R1 release evidence does not make stale cross-program certification claims', async () => {
  const generator = await fs.readFile(new URL('../scripts/generate-r1-release-evidence.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(generator, /R2 GENERAL control remains unpromoted/);
});


test('R1 schema compatibility explicitly accepts the current task observation schema and its supported previous version', () => {
  assert.equal(contractReadCompatibility('task-observation-summary', 2), 'current');
  assert.equal(contractReadCompatibility('task-observation-summary', 1), 'previous');
  assert.equal(contractReadCompatibility('task-observation-summary', 0), 'unsupported');
  assert.equal(contractReadCompatibility('task-observation-summary', 3), 'unsupported');
  assert.equal(contractReadCompatibility('execution-context-identity', 1), 'current');
  assert.equal(contractReadCompatibility('execution-context-identity', 2), 'unsupported');
});
