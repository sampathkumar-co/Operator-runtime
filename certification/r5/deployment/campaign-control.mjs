import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const state = path.join(root, 'state');
const command = process.argv[2];
if (!['start', 'resume', 'status', 'stop', 'smoke'].includes(command)) usage();

await fs.mkdir(state, { recursive: true, mode: 0o700 });
const dockerConfig = path.join(state, 'docker-config');
await fs.mkdir(dockerConfig, { recursive: true, mode: 0o700 });
const npmCache = path.join(state, 'npm-cache');
const metadataPath = path.join(state, 'campaign.json');
let metadata = await readJson(metadataPath);

if (command === 'smoke') {
  if (metadata && !metadata.endedAt) throw new Error('refusing to overlap an active campaign');
  const passwordPath = path.join(state, 'postgres_password');
  await fs.writeFile(passwordPath, crypto.randomBytes(32).toString('hex') + '\n', { mode: 0o600, flag: 'wx' });
  const smoke = { campaignId: 'r5-deployment-smoke', sourceSha: git(['rev-parse', 'HEAD']).trim() };
  try {
    installDependencies();
    try { compose(smoke, ['up', '-d', '--build', '--wait'], 'mecord-r5-smoke'); }
    catch (error) {
      compose(smoke, ['logs', '--no-color', '--tail', '200'], 'mecord-r5-smoke');
      throw error;
    }
    compose(smoke, ['ps'], 'mecord-r5-smoke');
  } finally {
    try { compose(smoke, ['down', '--volumes', '--remove-orphans'], 'mecord-r5-smoke'); }
    finally { await fs.rm(passwordPath, { force: true }); }
  }
} else if (command === 'start') {
  if (metadata && !metadata.endedAt) throw new Error(`campaign ${metadata.campaignId} is already active`);
  const sourceSha = git(['rev-parse', 'HEAD']).trim();
  if (!/^[0-9a-f]{40}$/.test(sourceSha)) throw new Error('source SHA is invalid');
  if (git(['status', '--porcelain']).trim()) throw new Error('refusing to start from a dirty source tree');
  const passwordPath = path.join(state, 'postgres_password');
  await fs.writeFile(passwordPath, crypto.randomBytes(32).toString('hex') + '\n', { mode: 0o600, flag: 'wx' }).catch(async (error) => {
    if (error?.code !== 'EEXIST') throw error;
  });
  metadata = {
    schemaVersion: 1,
    campaignId: `r5-operational-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`,
    sourceSha,
    startedAt: new Date().toISOString(),
    endedAt: null,
    topology: { controlPlane: 'postgresql', relayInstances: ['relay-a', 'relay-b'] }
  };
  await atomicJson(metadataPath, metadata);
  installDependencies();
  compose(metadata, ['up', '-d', '--build', '--wait']);
  process.stdout.write(JSON.stringify(metadata) + '\n');
} else if (command === 'resume') {
  requireActive(metadata);
  compose(metadata, ['up', '-d', '--wait']);
} else if (command === 'status') {
  if (!metadata) throw new Error('campaign has not been initialized');
  compose(metadata, ['ps', '--format', 'json']);
  process.stdout.write(JSON.stringify(metadata) + '\n');
} else {
  requireActive(metadata);
  compose(metadata, ['stop', '--timeout', '60']);
  metadata.endedAt = new Date().toISOString();
  await atomicJson(metadataPath, metadata);
  process.stdout.write(JSON.stringify(metadata) + '\n');
}

function compose(meta, args, projectName) {
  const result = spawnSync('docker', ['compose', ...(projectName ? ['--project-name', projectName] : []), '--file', path.join(root, 'compose.yml'), ...args], {
    cwd: root,
    env: { ...process.env, DOCKER_CONFIG: dockerConfig, OPERATOR_SOURCE_COMMIT: meta.sourceSha, R5_CAMPAIGN_ID: meta.campaignId },
    stdio: 'inherit'
  });
  if (result.status !== 0) throw new Error(`docker compose failed with exit ${result.status ?? 'unknown'}`);
}
function git(args) {
  const result = spawnSync('git', ['-C', path.resolve(root, '../../..'), ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || 'git failed');
  return result.stdout;
}
function installDependencies() {
  const result = spawnSync('npm', ['ci', '--prefix', 'apps/relay-server', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', npmCache], {
    cwd: path.resolve(root, '../../..'),
    stdio: 'inherit'
  });
  if (result.status !== 0) throw new Error(`relay dependency installation failed with exit ${result.status ?? 'unknown'}`);
}
function requireActive(value) { if (!value || value.endedAt) throw new Error('no active campaign'); }
async function readJson(file) { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) { if (error?.code === 'ENOENT') return null; throw error; } }
async function atomicJson(file, value) { const temp = file + '.tmp'; await fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); await fs.rename(temp, file); }
function usage() { process.stderr.write('usage: node campaign-control.mjs <start|resume|status|stop|smoke>\n'); process.exit(2); }
