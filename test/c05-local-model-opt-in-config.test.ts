import assert from 'node:assert/strict';
import test from 'node:test';
import { optionalLocalModelPlanners } from '../apps/local-agent/src/local-model-planner-config.ts';

const invalid = (config: Parameters<typeof optionalLocalModelPlanners>[0]) =>
  assert.throws(() => optionalLocalModelPlanners(config),
    (error: any) => error?.code === 'TASK_MODEL_CONFIG_INVALID' ||
      error?.code === 'TASK_MODEL_SUBGOAL_INVALID');

test('C05 local model remains disabled in default production startup and with explicit zero', () => {
  assert.equal(optionalLocalModelPlanners({}), undefined);
  assert.equal(optionalLocalModelPlanners({ enabled: '0' }), undefined);
  assert.equal(optionalLocalModelPlanners({ enabled: '' }), undefined);
});

test('C05 model ID alone never silently activates network inference', () => {
  invalid({ modelId: 'local-model:latest' });
  invalid({ enabled: '0', modelId: 'local-model:latest' });
  invalid({ enabled: 'true', modelId: 'local-model:latest' });
  invalid({ enabled: '1' });
  invalid({ enabled: '1', modelId: 'http://evil.example' });
  invalid({ enabled: '1', modelId: 'model\nsecret' });
});

test('C05 explicit local opt-in keeps all existing planner families and replaces only autonomous selector', () => {
  const planners = optionalLocalModelPlanners({ enabled: '1', modelId: 'local-model:latest' });
  assert.ok(planners);
  assert.deepEqual(planners.map(x => x.id), [
    'operator.project-quality-gate.v1',
    'operator.semantic.v1',
    'operator.semantic-workflow.v1',
    'operator.autonomous-workflow.v1'
  ]);
  const knownKinds = ['controlled-file-change', 'autonomous-workflow'] as const;
  assert.ok(planners.some(x => x.supports({ kind: knownKinds[1], roots: [], steps: [] } as any)));
  assert.ok(planners.some(x => x.supports({
    kind: knownKinds[0], root: '/owner-root', path: 'a.txt', content: 'safe'
  } as any)));
});


test('C05 dynamic checkpoint opt-in never activates the model by itself', () => {
  invalid({ composeEnabled: '1' });
  invalid({ enabled: '0', composeEnabled: '1' });
  invalid({ enabled: '1', modelId: 'model:latest', composeEnabled: 'true' });
  invalid({ enabled: '1', modelId: 'model:latest', composeEnabled: 'yes' });
  assert.ok(optionalLocalModelPlanners({ enabled: '1', modelId: 'model:latest', composeEnabled: '1' }));
  assert.deepEqual(optionalLocalModelPlanners({ enabled: '1', modelId: 'model:latest', composeEnabled: '1' })?.map(p => p.id),
    optionalLocalModelPlanners({ enabled: '1', modelId: 'model:latest' })?.map(p => p.id));
});
