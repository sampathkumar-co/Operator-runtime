# Verified Plan Runtime

A dependency-light, benchmark-agnostic planning layer for Mecord.

This package intentionally does **not** execute production actions and does not replace the
Adaptive Intelligence Core. It adds the missing future-state layer:

- structured goal and hard/soft constraint compilation;
- hierarchical dependency plan graphs with cycle checks;
- belief-bound preconditions and automatic invalidation;
- risk/cost/uncertainty/verification-aware branch ranking;
- bounded counterfactual lookahead over generic planning operators with beam/search budgets;
- execution modality compilation across GUI, DOM, accessibility, UIA, Playwright,
  application capabilities, API, MCP, and observation;
- local plan repair that preserves already-succeeded work;
- evidence-backed infeasibility detection instead of endless retries;
- irreversible-action preflight gates and node-bound verification receipt checks;
- deterministic plan/decision lineage and restart-safe state;
- reusable plan-fragment extraction that requires multi-run evidence, verification digests, fact abstraction, and rejects benchmark identifiers.

## Non-goals

- No benchmark task names, selectors, answers, or benchmark-specific heuristics.
- No direct authority decisions: authorization and verification receipts come from external
  production kernels.
- No duplication of Adaptive Intelligence failure attribution, causal truth, progress,
  calibration, or learning firewalls.
- No production execution or plan-graph control. `TaskOrchestrator` currently uses branch ranking only for capability-only low-risk recommendations in `SHADOW` mode; the production planner remains authoritative.

## Integration sequence

1. Qualify the package independently on every root repository check.
2. Reconcile the latest production Mecord runtime and the Adaptive Intelligence branch.
3. Shadow plan generation and record prediction-vs-outcome lineage.
4. Compare capability-only low-risk plan-node recommendations without executable inputs or plan mutation.
5. Compare identity-only local repair/replanning recommendations in shadow mode, bound to exact plan and authority lineage.
6. Compare hybrid execution modality compilation in shadow mode using the exact authorized production capability; stale/unavailable channels cannot route execution and uncertain mutations cannot switch modality.
7. Enable irreversible/high-risk control only behind production authority + verification.
8. Run restart/soak/security/performance validation, then frozen benchmark certification.
