import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packagePath = path.join(repoRoot, 'packages', 'mecord-connect', 'package.json');
const registryUrl = 'https://registry.npmjs.org/mecord-connect';
const maxBytes = 8 * 1024 * 1024;

export function assertNpmPolicyContinuity(packument, pkg) {
  if (pkg?.name !== 'mecord-connect') throw new Error('Unexpected npm package name.');
  const declaredClass = pkg?.contentPolicy?.class;
  if (declaredClass !== 'dual-use') {
    throw new Error('Mecord Connect releases must declare npm contentPolicy.class as dual-use.');
  }
  if (packument === null) return false;
  if (packument?.name !== 'mecord-connect') throw new Error('npm registry metadata package name mismatch.');
  if (!packument?.versions || typeof packument.versions !== 'object' || Array.isArray(packument.versions)) {
    throw new Error('npm registry metadata is missing the versions map.');
  }
  const versions = Object.values(packument.versions);
  for (const version of versions) {
    if (version?.contentPolicy && version.contentPolicy.class !== 'dual-use') {
      throw new Error('npm registry contains an unsupported published contentPolicy class.');
    }
  }
  const previouslyDualUse = versions.some((version) => version?.contentPolicy?.class === 'dual-use');
  if (previouslyDualUse && declaredClass !== 'dual-use') {
    throw new Error('Refusing release: npm dual-use declaration exists in published version history and must persist.');
  }
  return previouslyDualUse;
}

async function fetchPackument() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(registryUrl, {
      headers: { accept: 'application/json' },
      signal: controller.signal
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`npm registry metadata request failed with HTTP ${response.status}`);
    const declaredLength = Number(response.headers.get('content-length') || 0);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new Error('npm registry metadata exceeded size limit.');
    if (!response.body) throw new Error('npm registry metadata response had no body.');
    const reader = response.body.getReader();
    const chunks = [];
    let totalBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        controller.abort();
        throw new Error('npm registry metadata exceeded size limit.');
      }
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks, totalBytes).toString('utf8'));
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  const pkg = JSON.parse(await fs.readFile(packagePath, 'utf8'));
  const packument = await fetchPackument();
  const priorDualUse = assertNpmPolicyContinuity(packument, pkg);
  console.log(packument === null
    ? 'npm policy continuity: PASS (package not yet published)'
    : `npm policy continuity: PASS (prior dual-use=${priorDualUse})`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
