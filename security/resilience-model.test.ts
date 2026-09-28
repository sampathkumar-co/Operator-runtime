import assert from 'node:assert/strict';
import test from 'node:test';
import { compileResilienceMatrix } from '../src/core/resilience-matrix.ts';
import { simulateResilienceScenario } from '../src/core/resilience-simulator.ts';

const scenarios = compileResilienceMatrix();

test('all 1000 resilience scenarios satisfy the abstract control model', () => {
  const failures = scenarios
    .map((scenario) => simulateResilienceScenario(scenario))
    .filter((result) => result.unresolved.length > 0)
    .map((result) => ({ id: result.scenarioId, remaining: result.unresolved }));
  assert.deepEqual(failures, []);
});

test('all 40 failure families have distinct model signatures', () => {
  const baseline = scenarios.filter((scenario) => scenario.modifierId === 'M01');
  assert.equal(baseline.length, 40);
  const signatures = baseline.map((scenario) => simulateResilienceScenario(scenario).injected.join('|'));
  assert.equal(new Set(signatures).size, 40);
});

test('every modeled condition maps to an explicit control', () => {
  for (const scenario of scenarios) {
    const result = simulateResilienceScenario(scenario);
    for (const condition of result.injected) {
      assert.ok((result.controlCoverage[condition] ?? []).length > 0, `${scenario.id} lacks coverage for ${condition}`);
    }
  }
});
