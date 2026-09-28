import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FAILURE_FAMILIES,
  STRESS_CONDITIONS,
  compileResilienceMatrix,
  resilienceCoverage,
  validateResilienceScenario
} from '../src/core/resilience-matrix.ts';

const scenarios = compileResilienceMatrix();

test('resilience matrix contains exactly 1000 unique simulation-only cases', () => {
  assert.equal(FAILURE_FAMILIES.length, 40);
  assert.equal(STRESS_CONDITIONS.length, 25);
  assert.equal(scenarios.length, 1000);
  assert.equal(new Set(scenarios.map((scenario) => scenario.id)).size, 1000);
  assert.equal(new Set(scenarios.map((scenario) => scenario.title)).size, 1000);
  assert.equal(scenarios.every((scenario) => scenario.executionMode === 'simulation-or-sandbox-only'), true);
});

test('all 1000 resilience cases satisfy their control contract', () => {
  const failures = scenarios
    .map((scenario) => ({ id: scenario.id, violations: validateResilienceScenario(scenario) }))
    .filter((entry) => entry.violations.length > 0);
  assert.deepEqual(failures, []);
});

test('every family and modifier pair is represented exactly once', () => {
  const ids = new Set(scenarios.map((scenario) => scenario.id));
  for (const family of FAILURE_FAMILIES) {
    for (const modifier of STRESS_CONDITIONS) {
      assert.equal(ids.has(`${family.id}-${modifier.id}`), true, `missing ${family.id}-${modifier.id}`);
    }
  }
});

test('all twenty permanent invariants receive broad coverage', () => {
  const coverage = resilienceCoverage(scenarios);
  const expected = [
    'NEWEST_INTENT_WINS','WORKER_CANNOT_EXPAND_AUTHORITY','HYPOTHESIS_CANNOT_AUTHORIZE_IRREVERSIBLE_ACTION',
    'MODEL_CONFIDENCE_NEVER_GRANTS_PERMISSION','MINIMUM_NECESSARY_CONTEXT','WORKERS_CANNOT_MUTATE_CANONICAL_CONVERSATION',
    'UNCERTAIN_SIDE_EFFECTS_REQUIRE_RECONCILIATION','MUTATIONS_ARE_IDEMPOTENT','COMPLETION_REQUIRES_INDEPENDENT_VERIFICATION',
    'REASONING_AUTHORITY_EXECUTION_VERIFICATION_ARE_SEPARATE','BAD_WORKER_HAS_BOUNDED_BLAST_RADIUS',
    'PROVIDER_LOSS_IS_RECOVERABLE','LONG_TASKS_SURVIVE_FAILURE','PRIVACY_OVERRIDES_OPTIMIZATION',
    'LEARNING_NEVER_EXPANDS_AUTHORITY','CONSEQUENTIAL_ACTIONS_HAVE_CAUSAL_TRACE','BUDGETS_REMAIN_BOUNDED',
    'PARALLEL_MUTATION_IS_COORDINATED','ONE_COHERENT_USER_CONVERSATION','EXPLANATIONS_EXCLUDE_INTERNAL_CHATTER'
  ];
  for (const invariant of expected) {
    assert.ok((coverage.get(invariant as any) ?? 0) >= 25, `${invariant} lacks broad scenario coverage`);
  }
});

test('high-consequence cases require explicit authority and independent proof', () => {
  const critical = scenarios.filter((scenario) => scenario.modifierId === 'M25');
  assert.equal(critical.length, 40);
  for (const scenario of critical) {
    assert.equal(scenario.severity, 'critical');
    assert.ok(scenario.controls.includes('policy-fail-closed'));
    assert.ok(scenario.controls.includes('heterogeneous-verification'));
    assert.ok(scenario.controls.includes('action-bound-approval'));
  }
});

test('uncertain side effects and disaster recovery cannot become blind retries', () => {
  for (const scenario of scenarios.filter((entry) => ['F29','F30','F40'].includes(entry.familyId))) {
    assert.ok(scenario.controls.includes('side-effect-reconciliation'));
  }
});

test('restricted-data cases preserve data sovereignty and minimum context', () => {
  for (const scenario of scenarios.filter((entry) => entry.modifierId === 'M20')) {
    assert.ok(scenario.controls.includes('data-sovereignty'));
    assert.ok(scenario.controls.includes('minimum-context'));
  }
});

test('live user-intent changes require revalidation before continuation', () => {
  for (const scenario of scenarios.filter((entry) => ['M03','M04'].includes(entry.modifierId))) {
    assert.ok(scenario.controls.includes('intent-revalidation'));
  }
});

test('parallel workers require leases and revision checks', () => {
  for (const scenario of scenarios.filter((entry) => entry.modifierId === 'M06')) {
    assert.ok(scenario.controls.includes('resource-leases'));
    assert.ok(scenario.controls.includes('revision-cas'));
  }
});

test('historical replay cases bind identity, approval, idempotency and freshness', () => {
  for (const scenario of scenarios.filter((entry) => entry.modifierId === 'M15')) {
    assert.ok(scenario.controls.includes('idempotency'));
    assert.ok(scenario.controls.includes('action-bound-approval'));
    assert.ok(scenario.controls.includes('freshness-check'));
  }
});
