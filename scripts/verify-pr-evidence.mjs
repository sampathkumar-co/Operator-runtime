import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const WAVE0_PR_EVIDENCE_START = 404;
const SHA = /^[0-9a-f]{40}$/;
const HEADINGS = ['Source', 'Risk', 'Tests', 'Performance', 'Rollback', 'Physical acceptance', 'User outcome'];
function fail(reason) { throw new Error(`PR_EVIDENCE_INVALID: ${reason}`); }
export function validatePrEvidence({ number, headSha, body }) {
  if (!Number.isSafeInteger(number) || number < 1) fail('PR number invalid');
  if (number < WAVE0_PR_EVIDENCE_START) {
    return { status: 'GRANDFATHERED', number,
      reason: 'Opened before the first Wave 0 evidence-enforcement PR; review existing evidence manually.' };
  }
  if (typeof headSha !== 'string' || !SHA.test(headSha.toLowerCase())) fail('exact PR head SHA is required');
  if (typeof body !== 'string' || body.length > 200_000) fail('PR body required and bounded');
  const sections = new Map();
  let current = null;
  for (const line of body.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      current = heading[1].trim().toLowerCase();
      if (sections.has(current)) fail('duplicate evidence section');
      sections.set(current, []);
      continue;
    }
    if (current) sections.get(current).push(line);
  }
  const required = {};
  for (const label of HEADINGS) {
    const key = label.toLowerCase();
    const lines = sections.get(key);
    if (!lines) fail(`missing ## ${label} section`);
    const value = lines.join('\n')
      .replace(/<!--[\s\S]*?-->/g, '').trim();
    if (value.length < 10 || /^(?:todo|tbd|n\/a|none|pending)[.!\s]*$/i.test(value)) {
      fail(`## ${label} lacks evidence or an explicit NOT_RUN limitation`);
    }
    required[key] = value;
  }
  const source = required.source;
  const claimedHead = source.match(/(?:^|\n)\s*Head SHA:\s*([0-9a-f]{40})\s*(?:\n|$)/i)?.[1]?.toLowerCase();
  const baseline = source.match(/(?:^|\n)\s*Baseline SHA:\s*([0-9a-f]{40})\s*(?:\n|$)/i)?.[1]?.toLowerCase();
  if (!claimedHead || claimedHead !== headSha.toLowerCase() || !baseline) {
    fail('Source must provide current exact Head SHA and immutable Baseline SHA');
  }
  if (!/(?:read|write|external|system|destructive|mixed)/i.test(required.risk)) fail('Risk classification absent');
  if (!/(?:NOT_RUN|PENDING|https:\/\/github\.com\/[^\s]+\/actions\/runs\/\d+)/i.test(required.tests)) {
    fail('Tests must cite a GitHub CI run or state NOT_RUN/PENDING explicitly');
  }
  if (!/(?:NOT_MEASURED|https?:\/\/|p50|p95)/i.test(required.performance)) {
    fail('Performance must state NOT_MEASURED or give measurement evidence');
  }
  if (!/(?:NOT_RUN|DEFERRED|https?:\/\/)/i.test(required['physical acceptance'])) {
    fail('Physical acceptance requires recorded evidence or explicit NOT_RUN/DEFERRED status');
  }
  if (!/(?:NOT_RUN|DEFERRED|https?:\/\/|verified|observed)/i.test(required['user outcome'])) {
    fail('User outcome requires measured evidence or explicit NOT_RUN/DEFERRED status');
  }
  return { status: 'SOURCE_EVIDENCE_DECLARED', number, headSha: headSha.toLowerCase(),
    baselineSha: baseline,
    limitation: 'PR body fields are self-reported. Green gate does not prove independent outcomes or enforce branch protection.' };
}
function main() {
  const eventFile = process.env.GITHUB_EVENT_PATH;
  if (!eventFile) fail('GITHUB_EVENT_PATH missing');
  const event = JSON.parse(fs.readFileSync(eventFile, 'utf8'));
  const pr = event.pull_request;
  if (!pr) fail('Expected pull_request event');
  const result = validatePrEvidence({
    number: pr.number, headSha: pr.head?.sha, body: pr.body
  });
  process.stdout.write(JSON.stringify(result) + '\n');
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) main();
