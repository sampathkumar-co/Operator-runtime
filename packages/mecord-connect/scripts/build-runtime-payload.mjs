import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fsNative, { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(packageRoot, '..', '..');
const runtimeRoot = path.join(packageRoot, 'runtime');
const appRoot = path.join(runtimeRoot, 'app');
const nativeRoot = path.join(runtimeRoot, 'native');
const pkg = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'));

const gitExecutable = resolveTrustedGitExecutable(process.env);

function resolveTrustedGitExecutable(source) {
  const pathValue = source.PATH ?? source.Path ?? '';
  const names = process.platform === 'win32' ? ['git.exe', 'git.com'] : ['git'];
  for (const rawDirectory of String(pathValue).split(path.delimiter)) {
    const trimmed = rawDirectory.trim();
    const directory = trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')
      ? trimmed.slice(1, -1)
      : trimmed;
    if (!directory || !path.isAbsolute(directory)) continue;
    for (const name of names) {
      try {
        const resolved = fsNative.realpathSync.native(path.resolve(directory, name));
        const stat = fsNative.statSync(resolved);
        if (!path.isAbsolute(resolved) || !stat.isFile()) continue;
        if (process.platform !== 'win32') fsNative.accessSync(resolved, fsNative.constants.X_OK);
        return resolved;
      } catch { /* next trusted PATH candidate */ }
    }
  }
  throw new Error('Trusted Git executable was not found in absolute PATH directories.');
}

const helperSources = [
  ['operator-windows-dpapi.exe', process.env.OPERATOR_BUILD_DPAPI_PATH || path.join(repoRoot, 'native', 'windows-dpapi', 'target', 'release', 'operator-windows-dpapi.exe')],
  ['operator-windows-uia.exe', process.env.OPERATOR_BUILD_UIA_PATH || path.join(repoRoot, 'native', 'windows-uia', 'target', 'release', 'operator-windows-uia.exe')],
  ['operator-windows-path-lease.exe', process.env.OPERATOR_BUILD_PATH_LEASE_PATH || path.join(repoRoot, 'native', 'windows-path-lease', 'target', 'release', 'operator-windows-path-lease.exe')]
];

function gitText(args) {
  return execFileSync(gitExecutable, args, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

function assertTrackedRuntimeSourcesClean() {
  const status = gitText(['status', '--porcelain=v1', '--untracked-files=no', '--', 'src', 'apps/local-agent/src']);
  if (status) throw new Error('Runtime source tree contains tracked changes; refusing to bind modified bytes to HEAD.');
}

function rewriteTypeScriptSpecifiers(source) {
  return source.replace(/(['"])([^'"\r\n]+)\.ts\1/g, '$1$2.js$1');
}

async function compileTrackedTree(repoRelativeRoot, destinationRoot) {
  const raw = execFileSync(gitExecutable, ['ls-files', '-z', '--', repoRelativeRoot], { cwd: repoRoot, encoding: 'utf8' });
  const prefix = `${repoRelativeRoot}/`;
  const files = raw.split('\0').filter(Boolean);
  if (files.length === 0) throw new Error(`No tracked runtime sources found under ${repoRelativeRoot}.`);
  for (const repoRelative of files) {
    if (!repoRelative.startsWith(prefix) || !repoRelative.endsWith('.ts')) throw new Error(`Unexpected tracked runtime source: ${repoRelative}`);
    const relative = repoRelative.slice(prefix.length).replace(/\.ts$/, '.js');
    const source = path.join(repoRoot, ...repoRelative.split('/'));
    const destination = path.join(destinationRoot, ...relative.split('/'));
    const stat = await fs.lstat(source);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Refusing non-file tracked runtime source: ${repoRelative}`);
    const typescript = await fs.readFile(source, 'utf8');
    const javascript = rewriteTypeScriptSpecifiers(stripTypeScriptTypes(typescript, { mode: 'strip' }));
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, javascript, 'utf8');
  }
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
  const head = gitText(['rev-parse', 'HEAD']).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(head)) throw new Error('Checked-out Git HEAD must be a 40-character SHA.');
  const supplied = String(process.env.OPERATOR_SOURCE_COMMIT || '').trim();
  if (supplied) {
    if (!/^[0-9a-f]{40}$/i.test(supplied)) throw new Error('Runtime source commit must be a 40-character Git SHA.');
    if (supplied.toLowerCase() !== head) throw new Error('Runtime source commit does not match the checked-out Git HEAD.');
  }
  return head;
}

const commit = sourceCommit();
assertTrackedRuntimeSourcesClean();
await fs.rm(runtimeRoot, { recursive: true, force: true });
await fs.mkdir(nativeRoot, { recursive: true });
await compileTrackedTree('src', path.join(appRoot, 'src'));
await compileTrackedTree('apps/local-agent/src', path.join(appRoot, 'apps', 'local-agent', 'src'));

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
  package: 'mecord-connect',
  version: pkg.version,
  platform: 'win32',
  arch: 'x64',
  sourceCommit: commit,
  files
};
await fs.writeFile(path.join(runtimeRoot, 'runtime-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
console.log(`operator-runtime-payload:ok source=${manifest.sourceCommit} files=${files.length}`);
