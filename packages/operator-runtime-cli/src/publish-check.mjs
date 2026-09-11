import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateTrustedSigners } from './release.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const trust = JSON.parse(await fs.readFile(path.join(root, 'trusted-signers.json'), 'utf8'));
const signers = validateTrustedSigners(trust);

if (pkg.name !== 'operator-runtime-cli') throw new Error('Unexpected npm package name.');
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(pkg.version ?? ''))) throw new Error('Invalid npm package version.');
if (signers.length === 0) throw new Error('Refusing npm publish: no production Windows signer is pinned.');

console.log(`operator-runtime-cli publish check: PASS (${signers.length} trusted signer${signers.length === 1 ? '' : 's'})`);
