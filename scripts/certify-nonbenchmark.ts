import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const benchmarkTests = new Set(['test/benchmark-runner.test.ts']);
const requiredEvidence: Record<string, string[]> = {
  authority: ['test/authority-kernel.test.ts', 'test/executable-authority-boundary-audit.test.ts', 'test/intent-kernel.test.ts'],
  resources: ['test/resource-leases.test.ts', 'test/capability-sdk.test.ts'],
  exactlyOnce: ['test/action-execution-store.test.ts', 'test/action-transition-journal-integrity.test.ts', 'test/agent-kernel-p0.test.ts'],
  semanticVerification: ['test/verification-kernel.test.ts', 'test/task-orchestrator.test.ts'],
  privacy: ['test/account-erasure.test.ts', 'test/privacy-data.test.ts'],
  lifecycle: ['test/local-agent-instance-lock.test.ts', 'test/state-snapshot.test.ts', 'test/desired-state-reconciler.test.ts'],
  faultInjection: ['security/resilience-executable-evidence.test.ts', 'security/resilience-1000.test.ts'],
  performanceControls: ['performance/performance.test.ts', 'security/performance-control-evidence.test.ts'],
  browserDeterminism: ['test/browser-dom.test.ts', 'test/browser-m1.test.ts', 'test/browser-managed.test.ts', 'test/browser-navigation-postcondition-audit.test.ts'],
  packaging: ['test/npm-remote-runtime.test.ts', 'test/plugin-publication-package.test.ts', 'test/release-source-gate.test.ts', 'test/production-release-inputs.test.ts']
};

async function collectTests(directory: string): Promise<string[]> {
  return (await fs.readdir(path.join(root, directory), { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.ts'))
    .map((entry) => `${directory}/${entry.name}`)
    .filter((entry) => !benchmarkTests.has(entry))
    .sort();
}

async function run(command: string, args: string[], cwd = root): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', shell: false, windowsHide: true, env: process.env });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (signal) reject(new Error(`${command} terminated by signal ${signal}.`));
      else if (code !== 0) reject(new Error(`${command} exited with code ${code ?? 1}.`));
      else resolve();
    });
  });
}

const tests = [...await collectTests('test'), ...await collectTests('security'), ...await collectTests('performance')];
const selected = new Set(tests);
for (const [category, evidenceFiles] of Object.entries(requiredEvidence)) {
  for (const relative of evidenceFiles) {
    if (!selected.has(relative)) throw new Error(`Certification evidence missing for ${category}: ${relative}`);
    const stat = await fs.stat(path.join(root, relative));
    if (!stat.isFile() || stat.size === 0) throw new Error(`Certification evidence is empty for ${category}: ${relative}`);
  }
}

process.stdout.write(`# non-benchmark certification: ${tests.length} deterministic test files; ${Object.keys(requiredEvidence).length} required evidence categories\n`);
await run(process.execPath, ['--experimental-strip-types', 'scripts/check.ts']);
await run(process.execPath, ['--experimental-strip-types', 'scripts/run-test-suite.ts', ...tests]);

const npmCli = String(process.env.npm_execpath ?? '').trim();
if (!npmCli) throw new Error('npm_execpath is required for deterministic packaging smoke tests.');
for (const packageDirectory of ['packages/mecord-connect', 'packages/operator-runtime-cli']) {
  process.stdout.write(`# packaging smoke: ${packageDirectory}\n`);
  await run(process.execPath, [npmCli, 'pack', '--dry-run', '--ignore-scripts'], path.join(root, packageDirectory));
}

process.stdout.write('NONBENCHMARK_CERTIFICATION_PASS\n');
