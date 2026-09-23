import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const outputDir = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
fs.mkdirSync(outputDir, { recursive: true });

const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const part = () => Array.from({ length: 4 }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
const code = `MCRD-${part()}-${part()}`;
const digest = crypto.createHash('sha256').update(code).digest('hex');

const codePath = path.join(outputDir, 'registration-code.txt');
const envPath = path.join(outputDir, 'portal.env');

fs.writeFileSync(codePath, code + '\n', { mode: 0o600 });
fs.writeFileSync(envPath, `PORTAL_INVITE_SHA256=${digest}\n`, { mode: 0o600 });

console.log('Registration code file:', codePath);
console.log('Server hash file:', envPath);
