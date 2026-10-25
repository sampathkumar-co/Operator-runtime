import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWave0EvaluationReport } from './wave0-evaluation.mjs';

export async function reportForCurrentCheckout(inputPath) {
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim().toLowerCase();
  let input = {};
  if (inputPath) {
    const handle = await fs.open(inputPath, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size <= 0 || stat.size > 32 * 1024 * 1024) {
        throw new Error('WAVE0_EVALUATION_INVALID: input evidence size invalid');
      }
      const text = await handle.readFile('utf8');
      if (Buffer.byteLength(text, 'utf8') > 32 * 1024 * 1024) {
        throw new Error('WAVE0_EVALUATION_INVALID: input evidence size invalid');
      }
      input = JSON.parse(text);
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new Error('WAVE0_EVALUATION_INVALID: input evidence must be an object');
      }
    } finally {
      await handle.close();
    }
  }
  return buildWave0EvaluationReport({ ...input, sourceCommit });
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const inputPath = process.argv.length === 4 && process.argv[2] === '--input'
    ? process.argv[3] : undefined;
  if (process.argv.length > 2 && !inputPath) throw new Error('Use --input <recorded-evaluation.json>, or no arguments for an honest NOT_RUN report.');
  const report = await reportForCurrentCheckout(inputPath);
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}
