import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { optionalLocalPlanningInfluence } from '../apps/local-agent/src/local-model-advisor-config.ts';

test('C05 event advisor is OFF by default, without model network access', () => {
  assert.equal(optionalLocalPlanningInfluence({}), undefined);
  assert.equal(optionalLocalPlanningInfluence({ enabled: '' }), undefined);
  assert.equal(optionalLocalPlanningInfluence({ enabled: '0' }), undefined);
  assert.equal(optionalLocalPlanningInfluence({ enabled: '0', modelId: '' }), undefined);
});

test('C05 optional event advisor rejects implicit, malformed and URL-shaped model activation', () => {
  for (const config of [
    { modelId: 'gemma3:1b' },
    { enabled: '0', modelId: 'gemma3:1b' },
    { enabled: 'true', modelId: 'gemma3:1b' },
    { enabled: 'yes', modelId: 'gemma3:1b' },
    { enabled: '1' },
    { enabled: '1', modelId: 'https://evil.invalid/serve' },
    { enabled: '1', modelId: 'hf.co//bad' },
    { enabled: '1', modelId: '/model:tag' },
    { enabled: '1', modelId: 'user@host:tag' },
    { enabled: '1', modelId: 'bad name' },
    { enabled: '1', modelId: 'unsafe\\path' },
    { enabled: '1', modelId: 'x'.repeat(200) }
  ]) {
    assert.throws(() => optionalLocalPlanningInfluence(config),
      (e: any) => e?.code === 'TASK_ADVISORY_CONFIG_INVALID');
  }
});

test('C05 separately opted-in advisor uses the existing closed-schema runtime interface', () => {
  const provider = optionalLocalPlanningInfluence({
    enabled: '1', modelId: 'hf.co/owner/local-model:Q4_K_M'
  });
  assert.ok(provider);
  assert.equal(typeof provider.review, 'function');
});

test('C05 startup wiring cannot enable advisor without the exact owner env opt-in', async () => {
  const startup = await fs.readFile(path.resolve('apps/local-agent/src/main.ts'), 'utf8');
  assert.match(startup, /optionalLocalPlanningInfluence\(\{\s*enabled: process\.env\.OPERATOR_LOCAL_ADVISORY_MODEL_OPT_IN,/);
  assert.match(startup, /modelId: process\.env\.OPERATOR_LOCAL_ADVISORY_MODEL_ID/);
  assert.match(startup, /\.\.\.\(optionalEventAdvisor \? \{ planningInfluence: optionalEventAdvisor \} : \{\}\)/);
  assert.doesNotMatch(startup, /OPERATOR_LOCAL_ADVISORY_MODEL_ID\s*\|\|/);
});
