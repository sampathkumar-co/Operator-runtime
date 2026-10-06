# Verified Plan Runtime

A standalone, benchmark-agnostic planning layer for Mecord.

This package intentionally does **not** execute production actions and does not replace the
Adaptive Intelligence Core. It adds the missing future-state layer:

- structured goal and hard/soft constraint compilation;
- hierarchical dependency plan graphs with cycle checks;
- belief-bound preconditions and automatic invalidation;
- risk/cost/uncertainty/verification-aware branch ranking;\n- bounded counterfactual lookahead over generic planning operators with beam/search budgets;
- execution modality compilation across GUI, DOM, accessibility, UIA, Playwright,
  application capabilities, API, MCP, and observation;
- local plan repair that preserves already-succeeded work;
- evidence-backed infeasibility detection instead of endless retries;
- irreversible-action preflight gates and node-bound verification receipt checks;
- deterministic plan/decision lineage and restart-safe state;\n- reusable plan-fragment extraction that requires multi-run evidence, verification digests, fact abstraction, and rejects benchmark identifiers.

## Non-goals

- No benchmark task names, selectors, answers, or benchmark-specific heuristics.
- No direct authority decisions: authorization and verification receipts come from external
  production kernels.
- No duplication of Adaptive Intelligence failure attribution, causal truth, progress,
  calibration, or learning firewalls.
- No merge into the production TaskOrchestrator yet.

## Integration sequence

1. Keep this package isolated and qualify it independently.
2. Reconcile the latest production Mecord runtime and the Adaptive Intelligence branch.
3. Shadow plan generation and record prediction-vs-outcome lineage.
4. Enable observation selection and low-risk plan-node selection.
5. Enable local repair/replanning.
6. Enable hybrid execution compilation.
7. Enable irreversible/high-risk control only behind production authority + verification.
8. Run restart/soak/security/performance validation, then frozen benchmark certification.
