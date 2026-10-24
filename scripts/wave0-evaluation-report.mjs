import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWave0EvaluationReport } from './wave0-evaluation.mjs';

export async function reportForCurrentCheckout(inputPath) {
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim().toLowerCase();
  const input = inputPath ? JSON.parse(await fs.readFile(inputPath, 'utf8')) : {};
  return buildWave0EvaluationReport({ ...input, sourceCommit });
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const inputPath = process.argv.length === 4 && process.argv[2] === '--input'
    ? process.argv[3] : undefined;
  if (process.argv.length > 2 && !inputPath) throw new Error('Use --input <recorded-evaluation.json>, or no arguments for an honest NOT_RUN report.');
  const report = await reportForCurrentCheckout(inputPath);
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}
