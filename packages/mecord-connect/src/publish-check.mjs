import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyRuntimePayload } from './cli.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'));
if (pkg.name !== 'mecord-connect') throw new Error('Unexpected npm package name.');
if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error('Mecord Connect npm version must use stable semantic versioning.');

const manifest = await verifyRuntimePayload();
if (manifest.version !== pkg.version) {
  throw new Error(`Runtime manifest version ${manifest.version} does not match package ${pkg.version}.`);
}
const expectedCommit = String(process.env.OPERATOR_SOURCE_COMMIT || '').trim().toLowerCase();
if (!/^[0-9a-f]{40}$/.test(expectedCommit)) {
  throw new Error('Refusing npm publish: OPERATOR_SOURCE_COMMIT must be the exact 40-character publication commit.');
}
if (manifest.sourceCommit !== expectedCommit) {
  throw new Error(`Runtime payload source ${manifest.sourceCommit} does not match publication source ${expectedCommit}.`);
}
console.log(`mecord-connect publish check: PASS (${pkg.version}, source ${manifest.sourceCommit}, ${manifest.files.length} runtime files)`);
