# Wave 2 source coding progress — 2026-10-28

Branch: `work/wave2-complete-source-coding-20261028`  
Base: `77322f1958dd5f7dec3086e7f656b3d08a4e69fc`

This ledger describes source state only. It does not claim physical certification, a release, a deployed service, a real model run, or provider-independent proof from production systems. Optional inference remains default-off and has no execution authority.

| Task | Status | Source evidence and remaining boundary |
|---|---|---|
| C05-01 | IMPLEMENTED | Existing authority kernel, reviewed-model bridge/intake, one-use confirmation, and canonical task submission separate proposal from authority. Tests: `test/c05-reviewed-model-canonical-task-chain.test.ts`, `test/trusted-reviewed-model-task-intake.test.ts`. |
| C05-02 | IMPLEMENTED | `ProviderCapabilitySchema`, runtime schema discovery, v2 machine observations, evidence refs, and local planner causal observation/schema checks provide stable discoverable constraints for supported clients. Tests: `test/task-local-model-subgoal-planner.test.ts`, `test/task-orchestrator.test.ts`. |
| C05-03 | IMPLEMENTED | Existing deterministic semantic planners remain the default/fallback; local inference is optional and cannot manufacture steps. Tests: `test/task-local-model-subgoal-planner.test.ts`, `test/c05-local-model-opt-in-config.test.ts`. |
| C05-04 | IMPLEMENTED | Current bounded local planner/advisor contracts were retained and hardened; no benchmark controller or benchmark-specific selectors were added. Tests: `test/c05-bounded-async-canonical-planner.test.ts`, `test/task-local-model-planning-influence.test.ts`. |
| C05-05 | IMPLEMENTED | Provider-neutral generator/ranker/composer interfaces, minimized prompts, fixed loopback adapter, deadlines, abort fencing, durable pre-call budget reservation, and unknown-spend accounting exist. No external endpoint was contacted. Tests: `test/bounded-model-goal-inference.test.ts`, `test/c05-model-precall-charge.test.ts`, `test/durable-model-call-budget-ledger.test.ts`. |
| C05-06 | IMPLEMENTED | Model goal proposal validation produces typed goal/success conditions inside exact owner scope; trusted native confirmation is current-scope, principal-bound, one-use, and required before canonical submission. Tests: `test/model-goal-proposal.test.ts`, `test/reviewed-model-goal.test.ts`, `test/trusted-reviewed-model-task-intake.test.ts`. |
| C05-07 | IMPLEMENTED | Durable task plans support bounded dependency subgoals and revisions; optional composition may insert only runtime-owned read-only verification checkpoints based on a fresh observation. Tests: `test/task-plan.test.ts`, `test/task-local-model-subgoal-planner.test.ts`. |
| C05-08 | IMPLEMENTED | Planner context carries current exact provider schemas; selected schema and fresh causal observation refs are revalidated before a runtime-owned checkpoint is created. Tests: `test/task-local-model-subgoal-planner.test.ts`. |
| C05-09 | IMPLEMENTED | Orchestrator distinguishes invalid planner/schema repair, stale observation reobserve, no-progress/fallback behavior, and uncertain side-effect reconciliation. Tests: `test/task-reobserve.test.ts`, `test/task-orchestrator.test.ts`. |
| C05-10 | IMPLEMENTED | Durable model-call reservations survive failure without refund; durable plans have revisions/cancellation; action transition journal binds exact action id/digest/generation and completed replay state. Tests: `test/c05-durable-model-task-budget.test.ts`, `test/task-plan.test.ts`, `test/action-transition-journal-integrity.test.ts`. |
| C05-11 | IMPLEMENTED | Step/attempt/iteration budgets, Stop/Pause signals, no-progress handling, one-use confirmations, reconciliation quarantine, and non-retryable uncertain effects prevent speculative write loops. Tests: `test/task-decision-budget.test.ts`, `test/task-decision-budget-fail-closed.test.ts`, `test/task-stage3.test.ts`. |
| C05-12 | IMPLEMENTED | `test/c05-portable-production-e2e.test.ts` runs browser, application, file+Git, build/test, Docker, PostgreSQL, and download typed goals through production `TaskOrchestrator` + `AgentKernel`, including approval-bound restart and mutation no-replay, using only disposable synthetic providers. Optional proposal/composition, durable reservation/restart and deterministic fallback are covered by `test/c05-reviewed-model-canonical-task-chain.test.ts`, `test/c05-durable-model-task-budget.test.ts`, and `test/task-local-model-subgoal-planner.test.ts`; verified/partial/uncertain goal dispositions are covered by `test/outcome-contract.test.ts`. Physical/native provider certification remains `NOT_VERIFIED`. |
| C07-01 | IMPLEMENTED | `outcome-contract.ts` separately records dispatched time, provider post-state digest, and independently evaluated user outcome disposition. Test: `test/outcome-contract.test.ts`. |
| C07-02 | IMPLEMENTED | Versioned immutable outcome contracts cover browser, application, file+Git, build/test, Docker, trusted database, and download domains. Tests: `test/outcome-contract.test.ts`, `test/c05-portable-production-e2e.test.ts`. |
| C07-03 | IMPLEMENTED | `TaskOutcomeProofPolicy` registers exact opt-in goal/domain requirements. `TaskOrchestrator` obtains proof only at completion; `TaskVerifier` binds the signed receipt to the exact task, typed domain, terminal action digest/generation, plan revision, principal, device, freshness and configured observer, then `VerificationKernel` gates completion and the durable replay ledger is consumed before `VERIFIED`. Missing, forged, stale and replayed required proof fail closed in `test/c07-task-outcome-integration.test.ts`. Legacy completion is unchanged when no requirement is registered. Physical production observer rollout remains `NOT_VERIFIED`. |
| C07-04 | IMPLEMENTED | Evaluator rejects provider self-certification, stale/cross-plan receipts, signature failure, mismatched disposition, and success-looking evidence that lacks required typed checks. Tests: `test/outcome-contract.test.ts`, `test/c07-task-outcome-integration.test.ts`. |
| C07-05 | IMPLEMENTED | `correlated-server-outcome.ts` supplies a reusable, deliberately in-memory server-authoritative form/checkout/upload fixture with action id, resource generation, nonce, expected hashes and immutable receipt artifacts. Its independent read-only observer signs OutcomeContract receipts and rejects missing server state, client-only banners, duplicate submits, stale generations and hash mismatch. Covered by `test/c07-correlated-server-outcome.test.ts` and the TaskOrchestrator integration test. Live commerce/upload/auth/server certification remains `NOT_VERIFIED`. |
| C07-06 | IMPLEMENTED | Receipts bind contract/action digests, plan/action generations, principal, device, post-state hash, observer signature, receipt id and nonce; a durable one-use replay ledger rejects receipt or nonce reuse. Tests: `test/outcome-contract.test.ts`, `test/c07-task-outcome-integration.test.ts`. |
| C07-07 | IMPLEMENTED | Contract expiry, observation age, dispatch causality, signature/binding policy, unique exact checks, and all-required expectation evaluation gate `VERIFIED`. Test: `test/outcome-contract.test.ts`. |
| C07-08 | IMPLEMENTED | Recovery reports contain bounded status, exact safe evidence locations, and actionable reobserve/reconcile/correct-target/complete-subgoal remedies without raw outcome data. Test: `test/outcome-contract.test.ts`. |
| C07-09 | IMPLEMENTED | Existing `ProcedureMemoryStore` requires repeated independently distinct verified receipts, matching assumptions/scope/capabilities, TTL validity, and never grants authority. Test: `test/procedure-memory.test.ts`. |
| C07-10 | IMPLEMENTED | Adversarial tests cover no causal proof, false/self-certified banner, duplicate/replayed receipt, stale/cross-plan observation, later failed attempt, wrong download binding, truncated/inconclusive outcome, sparse arrays, and executable getters. Tests: `test/outcome-contract.test.ts`, `test/c07-causal-browser-outcome-proof.test.ts`, `test/c07-browser-download-outcome.test.ts`. |
| C07-11 | IMPLEMENTED | Stable human task outcome reports bind contract/action, disposition, receipt digest, creation time, and evidence-pack artifact refs while excluding raw page/form/path/database content. Test: `test/outcome-contract.test.ts`. |

## Source changes in this branch

- Added `src/core/outcome-contract.ts` and exported it from the core barrel.
- Integrated opt-in strict signed outcome proof into `TaskVerifier` and `TaskOrchestrator` without changing legacy/default completion.
- Added `src/core/correlated-server-outcome.ts` for disposable server-authoritative form/checkout/upload fixtures and independent receipt generation.
- Added exact inert schemas for seven outcome domains and independent signed receipts.
- Added freshness, all-required quality, identity/generation binding, disposition and signature evaluation.
- Added durable one-use receipt/nonce fencing, privacy-redacted recovery reports, and stable human evidence-pack reports.
- Added `test/outcome-contract.test.ts`, including heterogeneous and adversarial synthetic fixtures.
- Added `test/c07-task-outcome-integration.test.ts`, `test/c07-correlated-server-outcome.test.ts`, and `test/c05-portable-production-e2e.test.ts`.

## Verification run

- PASS: `node --experimental-strip-types --test test/c05-portable-production-e2e.test.ts test/c07-correlated-server-outcome.test.ts test/c07-task-outcome-integration.test.ts` — 9 passed, 0 failed.
- PASS: `test/outcome-contract.test.ts`, `test/task-verifier-failed-evidence.test.ts`, `test/verification-kernel.test.ts`, and `test/procedure-memory.test.ts` — 25 passed, 0 failed.
- PASS: optional model inference/review, canonical submission, durable-budget, and task-plan focused tests — 54 passed in the selected passing files. The broader selection also exposed one pre-existing `task-reobserve.test.ts` expectation mismatch (`FAILED` versus expected `BLOCKED`) unrelated to this diff; it is not counted as Wave 2 proof.
- ENVIRONMENT LIMIT: the broader focused aggregate reached 59 passed and one known environment failure: `WINDOWS_PATH_LEASE_HELPER_FAILED` in the older native-filesystem model-planner fixture. The new portable AgentKernel fixture passed and does not use that helper.
- NOT RUN: production TypeScript check. `npm run typecheck:production` cannot start because `apps/mcp-server/node_modules/typescript/bin/tsc` is absent; no dependencies were installed.
- NOT RUN: full `npm test`, physical Windows/UIA/browser/model tests, real checkout/upload/form servers, Docker/Postgres services, release, deployment, npm publication, or production access.

## Residual verification boundaries

No concrete in-scope source integration gap remains in C05/C07 after this pass. The remaining boundaries are empirical and are classified `NOT_VERIFIED`, not source-partial:

1. `NOT_VERIFIED`: real production provider/independent-observer rollout and key configuration for each domain.
2. `NOT_VERIFIED`: live server-side form integration and any separately authorized checkout/upload/auth integration; this pass intentionally performs no real payment, upload, authentication, or remote side effect.
3. `NOT_VERIFIED`: physical Windows/UIA/browser/Docker/PostgreSQL/download certification, multi-device proof, release/deployment/publication, and full source CI.
4. Tooling dependency limit: restore the repository-packaged Windows path-lease helper and TypeScript dependencies in a separate authorized environment, then run production typecheck and the complete source CI matrix.

All 23 ledger rows above describe source disposition. None is a claim of physical certification; all remaining physical verification is `NOT_VERIFIED`.

Final commit SHA: reported in the commit handoff (a commit cannot truthfully embed its own final SHA).
