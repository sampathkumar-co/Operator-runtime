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

test('expanded production hazards have explicit resolving controls', () => {
  const expected = new Map<string, string>([
    ['cross-action-resource-uncertainty', 'resource-quarantine'],
    ['hierarchical-resource-conflict', 'resource-leases'],
    ['unknown-process-liveness', 'resource-leases'],
    ['snapshot-partial-restore', 'transaction-recovery'],
    ['emergency-stop-mid-dispatch', 'emergency-cancellation'],
    ['terminal-orphan', 'transaction-recovery'],
    ['partial-completion-commit', 'transaction-recovery'],
    ['stale-authority-generation', 'monotonic-authority'],
    ['unresolved-target-selection', 'resource-leases']
  ]);
  const results = scenarios.map((scenario) => simulateResilienceScenario(scenario));
  const injected = new Set(results.flatMap((result) => result.injected));
  for (const [hazard, control] of expected) {
    assert.ok(injected.has(hazard), `${hazard} is never injected`);
    for (const result of results.filter((candidate) => candidate.injected.includes(hazard as any))) {
      assert.ok(result.controlCoverage[hazard]?.includes(control as any), `${result.scenarioId} lacks ${control} for ${hazard}`);
    }
  }
});

test('the full 1000-case simulation is deterministic across 10,000 executions', () => {
  const baseline = scenarios.map((scenario) => simulateResilienceScenario(scenario));
  for (let pass = 0; pass < 10; pass += 1) {
    assert.deepEqual(scenarios.map((scenario) => simulateResilienceScenario(scenario)), baseline);
  }
});
