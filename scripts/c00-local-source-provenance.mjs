import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SHA = /^[a-f0-9]{64}$/;
const FILE = /\.(?:ts|tsx|js|mjs|cjs|json|py|ps1|rs|cs|md)$/i;
const BLOCKED = new Set(['.operator','.ssh','.git','.mecord-secrets',
  '.env','node_modules','appdata','secrets','credentials','tokens']);
function invalid(message) { throw new Error('C00_LOCAL_PROVENANCE_INVALID: ' + message); }
function ownData(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype &&
       Object.getPrototypeOf(value) !== null)) invalid(label + ' must be a plain object');
  for (const key of Reflect.ownKeys(value)) {
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !keys.includes(key) || !desc ||
        !desc.enumerable || !('value' in desc)) invalid(label + ' contains unauthorized fields');
  }
  return value;
}
function safeParts(relative) {
  if (typeof relative !== 'string' || !relative || relative.length > 1024 ||
      relative.includes('\0') || path.isAbsolute(relative) ||
      /^[a-zA-Z]:/.test(relative)) invalid('each source must be explicitly relative');
  const normalized = relative.replace(/\\/g, '/').split('/');
  if (normalized.some(part => !part || part === '.' || part === '..' ||
      BLOCKED.has(part.toLowerCase()))) invalid('protected, hidden or escaping source path');
  if (!FILE.test(normalized.at(-1))) invalid('only bounded explicit source-like files may be read');
  return normalized;
}
function pseudo(key, value) {
  return crypto.createHmac('sha256', key).update(value).digest('hex');
}

/**
 * Source-only C00-06 forensic preparation.
 *
 * Read-only, file-by-file, manually selected source inventory. Never enumerate
 * .operator, SSH, credentials or protected recovery receipts. No shell, Git
 * mutation, file replacement, untracked scanning or inferred recovery claim.
 * Output contains NO raw paths, contents, filenames, device IDs or HMAC key.
 *
 * A missing independent reference digest cannot establish whether a file is
 * truly local-only. A matching digest is NOT authentication of its origin.
 */
export async function inspectExplicitLocalSourceProvenance(config) {
  ownData(config, ['root','relativePaths','referenceDigests','hmacKey'], 'configuration');
  if (typeof config.root !== 'string' || !path.isAbsolute(config.root) ||
      config.root.length > 32768 || !SHA.test(config.hmacKey) ||
      typeof config.hmacKey !== 'string' || !Array.isArray(config.relativePaths) ||
      config.relativePaths.length < 1 || config.relativePaths.length > 200 ||
      Reflect.ownKeys(config.relativePaths).length !== config.relativePaths.length + 1) {
    invalid('explicit root, private HMAC key and 1..200 dense source paths required');
  }
  const reference = ownData(config.referenceDigests ?? {},
    Object.keys(config.referenceDigests ?? {}), 'reference manifest');
  const selectedRoot = path.resolve(config.root);
  if (selectedRoot.split(/[\\/]+/).some(part => BLOCKED.has(part.toLowerCase()))) {
    invalid('protected state or secrets roots cannot be inventoried');
  }
  const rootStats = await fs.lstat(selectedRoot);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) invalid('root must be an ordinary directory');
  const realRoot = await fs.realpath(selectedRoot);
  const seen = new Set();
  const entries = [];
  for (const raw of config.relativePaths) {
    const pieces = safeParts(raw);
    const relative = pieces.join('/');
    if (seen.has(relative)) invalid('duplicate explicit source path');
    seen.add(relative);
    const file = path.resolve(selectedRoot, ...pieces);
    const difference = path.relative(selectedRoot, file);
    if (!difference || difference.startsWith('..') || path.isAbsolute(difference)) {
      invalid('source is outside the selected root');
    }
    // Reject symbolic-link ancestors, not merely a symlink at the leaf.
    let ancestor = selectedRoot;
    for (const part of pieces) {
      ancestor = path.join(ancestor, part);
      const stat = await fs.lstat(ancestor);
      if (stat.isSymbolicLink()) invalid('source contains a symlink or junction');
    }
    const real = await fs.realpath(file);
    const physicalDifference = path.relative(realRoot, real);
    if (!physicalDifference || physicalDifference.startsWith('..') ||
        path.isAbsolute(physicalDifference)) invalid('physical path escapes selected root');
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) invalid('source size or type invalid');
    const bytes = await fs.readFile(file);
    if (bytes.length !== stat.size) invalid('source changed during inventory');
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    const expected = Object.getOwnPropertyDescriptor(reference, relative)?.value;
    if (expected !== undefined && (typeof expected !== 'string' || !SHA.test(expected))) {
      invalid('reference digest must be an explicit SHA-256');
    }
    entries.push({
      sourceId: pseudo(config.hmacKey, relative),
      sizeBytes: bytes.length,
      sha256: digest,
      sourceDisposition: expected === undefined ? 'NO_INDEPENDENT_REFERENCE' :
        expected === digest ? 'MATCHES_DECLARED_REFERENCE' : 'DIFFERS_FROM_DECLARED_REFERENCE'
    });
  }
  return {
    schemaVersion:1,
    mode:'READ_ONLY_EXPLICIT_FILES',
    sourceRootId:pseudo(config.hmacKey, realRoot),
    inspected:entries.length,
    entries,
    independentProvenance:'NOT_AUTHENTICATED',
    historicalControllerRecovery:'NOT_VERIFIED',
    originalDeviceReceipts:'NOT_TOUCHED',
    releaseAcceptance:'NOT_ACCEPTED'
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  if (process.argv.length !== 4 || process.argv[2] !== '--manifest') {
    invalid('use --manifest <owner-selected-local-manifest.json>; no automatic filesystem scanning');
  }
  const stat = await fs.stat(process.argv[3]);
  if (!stat.isFile() || stat.size > 128 * 1024) invalid('source manifest too large');
  const manifest = JSON.parse(await fs.readFile(process.argv[3], 'utf8'));
  const report = await inspectExplicitLocalSourceProvenance(manifest);
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}
