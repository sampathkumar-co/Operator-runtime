import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

interface CanonicalSourceConfig {
  schemaVersion: 1;
  repository: string;
  canonicalCloseoutBranch: string;
  requiredAncestors: Array<{ name: string; sha: string }>;
  policy: {
    currentHeadMustContainEveryRequiredAncestor: boolean;
    productionPromotionMustUseReleaseTruth: boolean;
    historicalBranchesDoNotGrantProductionStatus: boolean;
  };
}

const root = path.resolve(import.meta.dirname, '..');
const config = JSON.parse(
  await fs.readFile(path.join(root, 'docs', 'r1-canonical-source.json'), 'utf8')
) as CanonicalSourceConfig;

if (config.schemaVersion !== 1 || config.repository !== 'sampathkumar-co/Operator-runtime') {
  throw new Error('R1 canonical source configuration is invalid.');
}
if (!config.policy?.currentHeadMustContainEveryRequiredAncestor ||
    !config.policy?.productionPromotionMustUseReleaseTruth ||
    !config.policy?.historicalBranchesDoNotGrantProductionStatus) {
  throw new Error('R1 canonical source policy must fail closed.');
}

const head = git(['rev-parse', 'HEAD']);
if (!/^[0-9a-f]{40}$/.test(head)) throw new Error('Current HEAD is not a full Git commit identity.');

const missing: string[] = [];
for (const entry of config.requiredAncestors) {
  if (!/^[0-9a-f]{40}$/.test(entry.sha)) throw new Error(`Invalid required ancestor SHA for ${entry.name}.`);
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', entry.sha, head], {
      cwd: root,
      stdio: 'ignore'
    });
  } catch {
    missing.push(`${entry.name} (${entry.sha})`);
  }
}
if (missing.length > 0) {
  throw new Error(`Current HEAD does not contain required canonical source state:\n${missing.join('\n')}`);
}

const releaseState = JSON.parse(
  await fs.readFile(path.join(root, 'docs', 'release-state.json'), 'utf8')
) as { production?: { sourceCommit?: string } };
const productionSource = String(releaseState.production?.sourceCommit ?? '').toLowerCase();
if (!/^[0-9a-f]{40}$/.test(productionSource)) {
  throw new Error('Recorded production source commit is invalid.');
}
try {
  execFileSync('git', ['cat-file', '-e', `${productionSource}^{commit}`], { cwd: root, stdio: 'ignore' });
} catch {
  throw new Error('Recorded production source commit is unavailable in the canonical source history.');
}

console.log(`r1-canonical-source:PASS head=${head} required_ancestors=${config.requiredAncestors.length} production=${productionSource}`);

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim().toLowerCase();
}
