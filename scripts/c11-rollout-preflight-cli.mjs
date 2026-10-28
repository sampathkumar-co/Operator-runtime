// Local non-publishing C11 rehearsal CLI. Consumes an explicitly supplied,
// bounded JSON declaration and refuses to execute any deploy or rollback.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessSourceMatchedRolloutPlan } from './c11-source-matched-rollout-plan.mjs';

export async function readRolloutPlanFile(filePath) {
  if (typeof filePath !== 'string' || !filePath || filePath.length > 4096) {
    throw new Error('C11_ROLLOUT_PLAN_FILE_INVALID');
  }
  const absolute = path.resolve(filePath);
  const info = await fs.lstat(absolute);
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > 64 * 1024) {
    throw new Error('C11_ROLLOUT_PLAN_FILE_INVALID');
  }
  const input = await fs.readFile(absolute, 'utf8');
  let declaration;
  try { declaration = JSON.parse(input); }
  catch { throw new Error('C11_ROLLOUT_PLAN_FILE_INVALID'); }
  return assessSourceMatchedRolloutPlan(declaration);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('C11_ROLLOUT_PLAN_FILE_INVALID');
  process.stdout.write(JSON.stringify(await readRolloutPlanFile(process.argv[2]), null, 2) + '\n');
}
