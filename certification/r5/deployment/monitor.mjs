import fs from 'node:fs/promises';
import crypto from 'node:crypto';

const interval = Number(process.env.MONITOR_INTERVAL_MS ?? 30_000);
if (!Number.isSafeInteger(interval) || interval < 5_000 || interval > 300_000) throw new Error('MONITOR_INTERVAL_MS is invalid');
const campaignId = required('CAMPAIGN_ID');
const sourceSha = required('SOURCE_SHA');
const output = '/evidence/health.jsonl';

async function observe() {
  const observedAt = new Date().toISOString();
  const services = {};
  for (const name of ['relay-a', 'relay-b']) {
    try {
      const response = await fetch(`http://${name}:8788/health`, { signal: AbortSignal.timeout(3000) });
      const body = await response.json();
      services[name] = { ok: response.ok && body?.ok === true && body?.clustered === true, status: response.status, instanceId: body?.instanceId ?? null };
    } catch (error) {
      services[name] = { ok: false, error: error instanceof Error ? error.name : 'Error' };
    }
  }
  const body = { schemaVersion: 1, campaignId, sourceSha, observedAt, services };
  const digest = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
  await fs.appendFile(output, JSON.stringify({ ...body, digest }) + '\n', { encoding: 'utf8', mode: 0o600 });
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

await observe();
setInterval(() => { void observe().catch((error) => process.stderr.write(String(error) + '\n')); }, interval);
