import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packagePath = path.join(repoRoot, 'packages', 'mecrod-operator', 'package.json');
const registryUrl = 'https://registry.npmjs.org/%40mecrod%2Foperator';
const maxBytes = 2 * 1024 * 1024;

export function assertNpmPolicyContinuity(packument, pkg) {
  const declaredClass = pkg?.contentPolicy?.class;
  if (pkg?.contentPolicy && declaredClass !== 'dual-use') {
    throw new Error('Unsupported npm contentPolicy.class; omit contentPolicy or use dual-use.');
  }
  const versions = packument?.versions && typeof packument.versions === 'object'
    ? Object.values(packument.versions)
    : [];
  const previouslyDualUse = versions.some((version) => version?.contentPolicy?.class === 'dual-use');
  if (previouslyDualUse && declaredClass !== 'dual-use') {
    throw new Error('Refusing release: npm dual-use declaration was present in a prior published version and must persist.');
  }
  return previouslyDualUse;
}

async function fetchPackument() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(registryUrl, {
      headers: { accept: 'application/vnd.npm.install-v1+json' },
      signal: controller.signal
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`npm registry metadata request failed with HTTP ${response.status}`);
    const declaredLength = Number(response.headers.get('content-length') || 0);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new Error('npm registry metadata exceeded size limit.');
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) throw new Error('npm registry metadata exceeded size limit.');
    return JSON.parse(text);
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
