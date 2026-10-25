import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const WAVE4_QUALIFICATION_GATES = Object.freeze([
  'three_lane_real_model_scoring',
  'fifty_held_out_real_user_workflows',
  'official_125_miniwob_supplement',
  'original_windows_chrome_edge_uia',
  'original_two_host_receipt_recovery',
  'independent_authority_and_no_replay',
  'signed_package_provenance_and_rollback',
  'owner_accepted_canary_and_stop',
  'post_release_telemetry_and_owner_publish'
]);

const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const STATUSES = new Set(['PASS', 'FAIL', 'NOT_RUN']);
const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
const MAX_ARTIFACTS_PER_GATE = 32;

function invalid(message) {
  throw new Error('WAVE4_QUALIFICATION_INVALID: ' + message);
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) {
    invalid(label + ' shape invalid');
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort()
      .map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function validRelativeArtifactPath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 &&
    !value.includes('\\') && !path.posix.isAbsolute(value) && path.posix.normalize(value) === value &&
    value.split('/').every(part => part && part !== '.' && part !== '..');
}

async function digestArtifact(root, artifact, candidateSha) {
  exactKeys(artifact, ['candidateSha', 'path', 'sha256'], 'artifact declaration');
  if (artifact.candidateSha !== candidateSha || !SHA.test(artifact.candidateSha)) {
    invalid('artifact source identity does not match exact candidate SHA');
  }
  if (!validRelativeArtifactPath(artifact.path) || typeof artifact.sha256 !== 'string' || !DIGEST.test(artifact.sha256)) {
    invalid('artifact path or SHA-256 is invalid');
  }
  const absolute = path.resolve(root, ...artifact.path.split('/'));
  if (absolute !== root && !absolute.startsWith(root + path.sep)) invalid('artifact escapes evidence root');

  const before = await fs.lstat(absolute).catch(() => null);
  if (!before?.isFile() || before.isSymbolicLink() || before.size <= 0 || before.size > MAX_ARTIFACT_BYTES) {
    invalid('artifact must be a bounded regular file: ' + artifact.path);
  }
  const physical = await fs.realpath(absolute);
  if (physical !== root && !physical.startsWith(root + path.sep)) invalid('artifact resolves outside evidence root');

  const handle = await fs.open(absolute, 'r');
  let bytes;
  try {
    const opened = await handle.stat();
    // Windows reports different device identifiers for path and handle stats, but
    // the stable file index (ino) and size still bind the opened handle.
    if (!opened.isFile() || opened.size !== before.size || opened.ino !== before.ino) {
      invalid('artifact identity changed before hashing: ' + artifact.path);
    }
    bytes = await handle.readFile();
    const after = await handle.stat();
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
      invalid('artifact changed while hashing: ' + artifact.path);
    }
  } finally {
    await handle.close();
  }
  const actual = crypto.createHash('sha256').update(bytes).digest('hex');
  if (actual !== artifact.sha256) invalid('artifact digest mismatch: ' + artifact.path);
  return { path: artifact.path, sha256: actual, sizeBytes: bytes.length };
}

export function notRunDeclaration(candidateSha) {
  if (typeof candidateSha !== 'string' || !SHA.test(candidateSha)) invalid('candidate SHA invalid');
  return {
    schemaVersion: 1,
    candidateSha,
    gates: Object.fromEntries(WAVE4_QUALIFICATION_GATES.map(gate => [gate, {
      status: 'NOT_RUN',
      summary: 'No authenticated qualification artifact supplied to this source-only run.',
      artifacts: []
    }]))
  };
}

export async function buildWave4QualificationEvidence({ candidateSha, evidenceRoot, declaration }) {
  if (typeof candidateSha !== 'string' || !SHA.test(candidateSha)) invalid('candidate SHA invalid');
  exactKeys(declaration, ['candidateSha', 'gates', 'schemaVersion'], 'declaration');
  if (declaration.schemaVersion !== 1 || declaration.candidateSha !== candidateSha) {
    invalid('declaration does not match exact candidate SHA or schema');
  }
  exactKeys(declaration.gates, WAVE4_QUALIFICATION_GATES, 'qualification gate roster');
  const root = await fs.realpath(path.resolve(evidenceRoot));
  const usedPaths = new Set();
  const gates = [];

  for (const gate of WAVE4_QUALIFICATION_GATES) {
    const entry = declaration.gates[gate];
    exactKeys(entry, ['artifacts', 'status', 'summary'], gate);
    if (!STATUSES.has(entry.status) || typeof entry.summary !== 'string' ||
        entry.summary.length < 1 || entry.summary.length > 500 || entry.summary.trim() !== entry.summary ||
        !Array.isArray(entry.artifacts) || entry.artifacts.length > MAX_ARTIFACTS_PER_GATE) {
      invalid(gate + ' status, summary or artifacts invalid');
    }
    if (entry.status === 'NOT_RUN' && entry.artifacts.length !== 0) {
      invalid(gate + ' NOT_RUN cannot attach execution evidence');
    }
    if (entry.status !== 'NOT_RUN' && entry.artifacts.length === 0) {
      invalid(gate + ' ' + entry.status + ' requires digest-bound evidence');
    }
    const artifacts = [];
    for (const artifact of entry.artifacts) {
      if (typeof artifact?.path !== 'string' || usedPaths.has(artifact.path)) {
        invalid('qualification artifacts must have globally unique paths');
      }
      usedPaths.add(artifact.path);
      artifacts.push(await digestArtifact(root, artifact, candidateSha));
    }
    artifacts.sort((left, right) => left.path.localeCompare(right.path));
    const evidenceSha256 = artifacts.length
      ? crypto.createHash('sha256').update(canonicalJson(artifacts)).digest('hex')
      : null;
    gates.push({ gate, status: entry.status, summary: entry.summary, artifacts, evidenceSha256 });
  }

  const counts = {
    pass: gates.filter(gate => gate.status === 'PASS').length,
    fail: gates.filter(gate => gate.status === 'FAIL').length,
    notRun: gates.filter(gate => gate.status === 'NOT_RUN').length
  };
  // Supplied SHA-matching artifacts attest bytes, not issuer authority or independent gate approval.
  // A caller may self-declare every gate PASS; never elevate that to QUALIFIED.
  const qualificationStatus = counts.fail ? 'FAILED' : counts.notRun ? 'INCOMPLETE' : 'ALL_GATES_DECLARED_PASS_UNVERIFIED';
  const manifest = {
    schemaVersion: 1,
    candidateSha,
    qualificationStatus,
    counts,
    gates,
    publicationAllowed: false,
    limitation: 'This digest-bound source artifact records supplied evidence. It never publishes, deploys, signs, or replaces owner release acceptance.'
  };
  return {
    ...manifest,
    manifestSha256: crypto.createHash('sha256').update(canonicalJson(manifest)).digest('hex')
  };
}

async function readDeclaration(inputPath) {
  const handle = await fs.open(inputPath, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_INPUT_BYTES) invalid('input declaration size invalid');
    return JSON.parse(await handle.readFile('utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) invalid('input declaration is not valid JSON');
    throw error;
  } finally {
    await handle.close();
  }
}

export async function qualificationForCurrentCheckout({ inputPath, evidenceRoot } = {}) {
  const repositoryRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  const candidateSha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repositoryRoot, encoding: 'utf8'
  }).trim().toLowerCase();
  if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== candidateSha) {
    invalid('GitHub run SHA differs from source checkout SHA');
  }
  const declaration = inputPath ? await readDeclaration(path.resolve(inputPath)) : notRunDeclaration(candidateSha);
  return buildWave4QualificationEvidence({
    candidateSha,
    evidenceRoot: evidenceRoot ? path.resolve(evidenceRoot) : repositoryRoot,
    declaration
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let inputPath;
  let evidenceRoot;
  for (let i = 2; i < process.argv.length; i += 2) {
    const name = process.argv[i];
    const value = process.argv[i + 1];
    if (!value || (name !== '--input' && name !== '--evidence-root')) {
      invalid('use --input <declaration.json> and --evidence-root <directory>, or no arguments');
    }
    if (name === '--input' && inputPath === undefined) inputPath = value;
    else if (name === '--evidence-root' && evidenceRoot === undefined) evidenceRoot = value;
    else invalid('duplicate or unsupported CLI argument');
  }
  const report = await qualificationForCurrentCheckout({ inputPath, evidenceRoot });
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}
