import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const CORE_SURFACES = Object.freeze([
  'src/core/task-orchestrator.ts',
  'src/core/model-goal-proposal.ts',
  'src/core/reviewed-model-goal.ts',
  'apps/local-agent/src/runtime-factory.ts',
  'apps/mcp-server/src/public-tools.ts'
]);
const BENCHMARK_REFERENCE = /miniwob|browsergym|wob\.(?:mini|task)|benchmark[-_ ](?:task|selector|specific)/i;
function invalid(message) {
  throw new Error('C03_PRODUCTION_BROWSER_GENERICITY_INVALID: ' + message);
}

export function verifyProductionBrowserGenericity({ files, roster }) {
  if (!files || typeof files !== 'object' || Array.isArray(files) ||
      !roster || typeof roster !== 'object' || Array.isArray(roster)) {
    invalid('source and frozen benchmark roster are required');
  }
  if (!Array.isArray(roster.taskIds) || roster.taskIds.length !== 125 ||
      new Set(roster.taskIds).size !== 125 ||
      roster.taskIds.some(id => typeof id !== 'string' ||
        !/^miniwob\.[a-z0-9-]+$/.test(id))) {
    invalid('official 125-task source roster identity missing or changed');
  }
  const entries = Object.entries(files);
  const browserFiles = entries.filter(([name]) =>
    /^src\/capabilities\/browser-[a-z0-9-]+\.ts$/.test(name));
  if (browserFiles.length < 4 || browserFiles.length > 30 ||
      CORE_SURFACES.some(name => !Object.hasOwn(files, name))) {
    invalid('browser production file census incomplete');
  }
  const tasks = roster.taskIds.map(id => id.slice('miniwob.'.length))
    .filter(name => name.length >= 8 && name.includes('-'));
  for (const [filename, bytes] of entries) {
    if (typeof bytes !== 'string' || bytes.length === 0 ||
        Buffer.byteLength(bytes, 'utf8') > 2 * 1024 * 1024) {
      invalid('source unavailable or oversized: ' + filename);
    }
    if (BENCHMARK_REFERENCE.test(bytes)) {
      invalid('benchmark-specific source reference in ' + filename);
    }
    if (filename.startsWith('src/capabilities/browser-')) {
      const taskName = tasks.find(name => bytes.includes(name));
      if (taskName) invalid('hard-coded frozen benchmark task name in ' + filename + ': ' + taskName);
    }
  }
  const contentHashes = entries
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, content]) => [file, crypto.createHash('sha256').update(content).digest('hex')]);
  const rosterDigest = crypto.createHash('sha256')
    .update(JSON.stringify(roster.taskIds)).digest('hex');
  return {
    schemaVersion: 1, status: 'SOURCE_GENERICITY_CHECK_PASSED',
    rosterCount: 125, rosterDigest,
    browserSourceCount: browserFiles.length,
    checkedFiles: contentHashes,
    independentUserOutcome: 'NOT_RUN',
    physicalBrowserCertification: 'NOT_RUN_IN_THIS_SOURCE_GATE',
    releaseApproval: 'NOT_GRANTED',
    limitation: 'Text scan rejects known frozen task IDs and benchmark-specific references. It cannot prove intent, performance, hidden runtime behavior or full independent evaluation.'
  };
}

export async function verifyCurrentSourceGenericity(root = SOURCE_ROOT) {
  const browserDir = path.join(root, 'src', 'capabilities');
  const browserFiles = (await fs.readdir(browserDir))
    .filter(name => /^browser-[a-z0-9-]+\.ts$/.test(name))
    .map(name => 'src/capabilities/' + name);
  const names = [...CORE_SURFACES, ...browserFiles];
  const files = Object.fromEntries(await Promise.all(names.map(async name =>
    [name, await fs.readFile(path.join(root, name), 'utf8')])));
  const roster = JSON.parse(await fs.readFile(path.join(
    root, 'certification/wave0/miniwob-125-v0143.json'), 'utf8'));
  return verifyProductionBrowserGenericity({ files, roster });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await verifyCurrentSourceGenericity();
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
