# Wave 2 source coding progress — 2026-10-28

Branch: `work/wave2-complete-source-coding-20261028`  
Base: `77322f1958dd5f7dec3086e7f656b3d08a4e69fc`

This ledger describes source state only. It does not claim physical certification, a release, a deployed service, a real model run, or provider-independent proof from production systems. Optional inference remains default-off and has no execution authority.

| Task | Status | Source evidence and remaining boundary |
|---|---|---|
| C05-01 | IMPLEMENTED | Existing authority kernel, reviewed-model bridge/intake, one-use confirmation, and canonical task submission separate proposal from authority. |
| C05-02 | IMPLEMENTED | `ProviderCapabilitySchema`, runtime schema discovery, v2 machine observations, evidence refs, and local planner causal observation/schema checks provide stable discoverable constraints for supported clients. |
| C05-03 | IMPLEMENTED | Existing deterministic semantic planners remain the default/fallback; local inference is optional and cannot manufacture steps. |
| C05-04 | IMPLEMENTED | Current bounded local planner/advisor contracts were retained and hardened; no benchmark controller or benchmark-specific selectors were added. Historical code is treated as untrusted until covered by focused tests. |
| C05-05 | IMPLEMENTED | Provider-neutral generator/ranker/composer interfaces, minimized prompts, fixed loopback adapter, deadlines, abort fencing, durable pre-call budget reservation, and unknown-spend accounting exist. No external endpoint was contacted. |
| C05-06 | IMPLEMENTED | Model goal proposal validation produces typed goal/success conditions inside exact owner scope; trusted native confirmation is current-scope, principal-bound, one-use, and required before canonical submission. |
| C05-07 | IMPLEMENTED | Durable task plans support bounded dependency subgoals and revisions; optional composition may insert only runtime-owned read-only verification checkpoints based on a fresh observation. |
| C05-08 | IMPLEMENTED | Planner context carries current exact provider schemas; selected schema and fresh causal observation refs are revalidated before a runtime-owned checkpoint is created. |
| C05-09 | IMPLEMENTED | Orchestrator distinguishes invalid planner/schema repair, stale observation reobserve, no-progress/fallback behavior, and uncertain side-effect reconciliation. Focused task reobserve/orchestrator tests exist. |
| C05-10 | IMPLEMENTED | Durable model-call reservations survive failure without refund; durable plans have revisions/cancellation; action transition journal binds exact action id/digest/generation and completed replay state. |
| C05-11 | IMPLEMENTED | Step/attempt/iteration budgets, Stop/Pause signals, no-progress handling, one-use confirmations, reconciliation quarantine, and non-retryable uncertain effects prevent speculative write loops. |
| C05-12 | PARTIAL | Source-executable heterogeneous proof fixtures cover browser, application, file+Git, build/test, Docker, trusted DB, and download without MiniWoB. The existing production-runtime filesystem integration fixture could not run here because the packaged Windows path-lease helper is absent; no physical E2E claim is made. |
| C07-01 | IMPLEMENTED | `outcome-contract.ts` separately records dispatched time, provider post-state digest, and independently evaluated user outcome disposition. |
| C07-02 | IMPLEMENTED | Versioned immutable outcome contracts cover browser, application, file+Git, build/test, Docker, trusted database, and download domains. |
| C07-03 | PARTIAL | Freshness, independent observer identity/signature, and `VERIFIED`/`PARTIAL`/`INCONCLUSIVE`/`UNCERTAIN`/`NOT_COMPLETE` types are implemented. Existing task verifiers already use fresh typed observations, but every production provider does not yet emit this new signed receipt format. |
| C07-04 | IMPLEMENTED | Evaluator rejects provider self-certification, stale/cross-plan receipts, signature failure, mismatched disposition, and success-looking evidence that lacks required typed checks. |
| C07-05 | PARTIAL | Synthetic server-correlated form/checkout/upload-style receipt locations and causal browser/download fixtures are covered. No real server observer/checkout/upload integration was exercised or certified. |
| C07-06 | IMPLEMENTED | Receipts bind contract/action digests, plan/action generations, principal, device, post-state hash, observer signature, receipt id and nonce; a durable one-use replay ledger rejects receipt or nonce reuse. |
| C07-07 | IMPLEMENTED | Contract expiry, observation age, dispatch causality, signature/binding policy, unique exact checks, and all-required expectation evaluation gate `VERIFIED`. |
| C07-08 | IMPLEMENTED | Recovery reports contain bounded status, exact safe evidence locations, and actionable reobserve/reconcile/correct-target/complete-subgoal remedies without raw outcome data. |
| C07-09 | IMPLEMENTED | Existing `ProcedureMemoryStore` requires repeated independently distinct verified receipts, matching assumptions/scope/capabilities, TTL validity, and never grants authority. Focused tests pass. |
| C07-10 | IMPLEMENTED | Adversarial tests cover no causal proof, false/self-certified banner, duplicate/replayed receipt, stale/cross-plan observation, later failed attempt, wrong download binding, truncated/inconclusive outcome, sparse arrays, and executable getters. |
| C07-11 | IMPLEMENTED | Stable human task outcome reports bind contract/action, disposition, receipt digest, creation time, and evidence-pack artifact refs while excluding raw page/form/path/database content. |

## Source changes in this branch

- Added `src/core/outcome-contract.ts` and exported it from the core barrel.
- Added exact inert schemas for seven outcome domains and independent signed receipts.
- Added freshness, all-required quality, identity/generation binding, disposition and signature evaluation.
- Added durable one-use receipt/nonce fencing, privacy-redacted recovery reports, and stable human evidence-pack reports.
- Added `test/outcome-contract.test.ts`, including heterogeneous and adversarial synthetic fixtures.

## Verification run

- PASS: `node --experimental-strip-types --test test/outcome-contract.test.ts test/c07-causal-browser-outcome-proof.test.ts test/c07-browser-download-outcome.test.ts test/procedure-memory.test.ts` — final result recorded in the commit handoff.
- PASS/PARTIAL: focused C05/C07 aggregate — 102 passed, one environment failure: `WINDOWS_PATH_LEASE_HELPER_FAILED` in the existing production-runtime filesystem integration fixture.
- NOT RUN: production TypeScript check. `npm run typecheck:production` could not start because `apps/mcp-server/node_modules/typescript/bin/tsc` is absent; no dependencies were installed.
- NOT RUN: full `npm test`, physical Windows/UIA/browser/model tests, real checkout/upload/form servers, Docker/Postgres services, release, deployment, npm publication, or production access.

## Residual source gaps

1. Wire signed independent outcome receipts into each applicable production provider/observer pair and make that receipt a mandatory runtime verification input where a domain requires independent server/device proof.
2. Add real server-side form/checkout/upload observers with correlation IDs and privacy-bounded evidence artifacts.
3. Restore the repository-packaged Windows path-lease helper and TypeScript dependencies in a separate authorized environment, then run production typecheck and the complete source CI matrix.

Final commit SHA: reported in the commit handoff (a commit cannot truthfully embed its own final SHA).
