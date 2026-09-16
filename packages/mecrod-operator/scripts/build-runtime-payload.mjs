import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(packageRoot, '..', '..');
const runtimeRoot = path.join(packageRoot, 'runtime');
const appRoot = path.join(runtimeRoot, 'app');
const nativeRoot = path.join(runtimeRoot, 'native');
const pkg = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'));

const helperSources = [
  ['operator-windows-dpapi.exe', process.env.OPERATOR_BUILD_DPAPI_PATH || path.join(repoRoot, 'native', 'windows-dpapi', 'target', 'release', 'operator-windows-dpapi.exe')],
  ['operator-windows-uia.exe', process.env.OPERATOR_BUILD_UIA_PATH || path.join(repoRoot, 'native', 'windows-uia', 'target', 'release', 'operator-windows-uia.exe')],
  ['operator-windows-path-lease.exe', process.env.OPERATOR_BUILD_PATH_LEASE_PATH || path.join(repoRoot, 'native', 'windows-path-lease', 'target', 'release', 'operator-windows-path-lease.exe')]
];

async function copyTree(source, destination) {
  const stat = await fs.lstat(source);
  if (stat.isSymbolicLink()) throw new Error(`Refusing symbolic link in runtime source: ${source}`);
  if (stat.isDirectory()) {
    await fs.mkdir(destination, { recursive: true });
    for (const name of await fs.readdir(source)) {
      await copyTree(path.join(source, name), path.join(destination, name));
    }
    return;
  }
  if (!stat.isFile()) throw new Error(`Unsupported runtime source entry: ${source}`);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination);
}

async function sha256(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function listFiles(root, relative = '') {
  const directory = path.join(root, ...relative.split('/').filter(Boolean));
  const output = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const next = relative ? `${relative}/${entry.name}` : entry.name;
    if (next === 'runtime-manifest.json') continue;
    const full = path.join(root, ...next.split('/'));
    const stat = await fs.lstat(full);
    if (stat.isSymbolicLink()) throw new Error(`Refusing symbolic link in runtime payload: ${next}`);
    if (stat.isDirectory()) output.push(...await listFiles(root, next));
    else if (stat.isFile()) output.push(next);
    else throw new Error(`Unsupported runtime payload entry: ${next}`);
  }
  return output;
}

function sourceCommit() {
  const supplied = String(process.env.OPERATOR_SOURCE_COMMIT || '').trim();
  const value = supplied || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  if (!/^[0-9a-f]{40}$/i.test(value)) throw new Error('Runtime source commit must be a 40-character Git SHA.');
  return value.toLowerCase();
}

await fs.rm(runtimeRoot, { recursive: true, force: true });
await fs.mkdir(nativeRoot, { recursive: true });
await copyTree(path.join(repoRoot, 'src'), path.join(appRoot, 'src'));
await copyTree(path.join(repoRoot, 'apps', 'local-agent', 'src'), path.join(appRoot, 'apps', 'local-agent', 'src'));
await fs.writeFile(path.join(appRoot, 'package.json'), JSON.stringify({ private: true, type: 'module' }, null, 2) + '\n', 'utf8');

for (const [name, source] of helperSources) {
  const stat = await fs.stat(source).catch(() => null);
  if (!stat?.isFile() || stat.size < 1) throw new Error(`Required native helper is missing: ${source}`);
  await fs.copyFile(source, path.join(nativeRoot, name));
}

const paths = (await listFiles(runtimeRoot)).sort();
const files = [];
for (const relative of paths) {
  const file = path.join(runtimeRoot, ...relative.split('/'));
  const stat = await fs.stat(file);
  files.push({ path: relative, sizeBytes: stat.size, sha256: await sha256(file) });
}

const manifest = {
  schemaVersion: 1,
  package: '@mecrod/operator',
  version: pkg.version,
  platform: 'win32',
  arch: 'x64',
  sourceCommit: sourceCommit(),
  files
};
await fs.writeFile(path.join(runtimeRoot, 'runtime-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
console.log(`operator-runtime-payload:ok source=${manifest.sourceCommit} files=${files.length}`);
