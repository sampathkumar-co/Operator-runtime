# Production autonomy gap analysis — 2026-10-22

**Reviewed:** `origin/main` at `8aa4fa909ad175fddb2c68d8d7b7e1279db13d86`, in isolated worktree `feature/production-autonomy-contract-20261022`. PR #359 was reviewed as a separate benchmark-oriented implementation; it is not the production planner. This is an initial source-level audit, not an end-to-end certification.

| Priority | Source/function | Current production behavior | Gap / real-user impact | Safety requirement / acceptance |
| --- | --- | --- | --- | --- |
| P0 | `apps/local-agent/src/server.ts:1867-1917` POST /v1/tasks | Requires typed `body.goal` and submits to TaskOrchestrator | Natural-language-only requests cannot independently become authorized executable goals | Add explicit user-intent interpreter with scoped, reviewable contract; reject invented permissions/credentials |
| P0 | `apps/local-agent/src/main.ts:477` constructor | Default built-in deterministic planners; no model-backed planner registered | Model does not make general-purpose production task decisions | Register opt-in policy-aware model planner only after verified security, privacy, budget gates |
| P0 | `src/core/task-orchestrator.ts:1819` AutonomousWorkflowPlanner | Executes predeclared observe/action/verify triples with bounded pagination | Cannot autonomously decompose an unfamiliar task into novel verified actions | General model planner must preserve independent verification |
| P1 | `src/core/task-orchestrator-contracts.ts` TaskPlanner | Previously synchronous next/repair | Remote model calls cannot participate as asynchronous planner decisions | **This increment:** async next/repair with deadline, AbortSignal, validation and no unauthorized provider dispatch; test covered |
| P1 | `src/core/task-orchestrator.ts:408` decision loop | Schema checks, canonical risk resolution, task budgets, durable journal and verification | Async model decisions needed fail-closed timing/cancellation | **This increment:** 30-second-per-call ceiling and earlier task deadline, pause-only planning cancellation |
| P1 | `src/capabilities/browser-cdp.ts` BrowserCdpProvider | Existing browser capability provider; inspect and interact are real provider paths | Model-driven visual fallback, broad controls and cross-site generalization remain unaccepted | Nonbenchmark observation-grounded interaction tests |
| P1 | `src/core/task-intelligence.ts` and adaptive shadow modules | Retrieves context and emits advisory/shadow intelligence | Advisory outputs do not own executable decisions | Any promotion requires explicit evidence and authority checks |
| P0 | `src/core/agent-kernel.ts` and `main.ts` executeAction | Production main routes task actions through AgentKernel | Must prove model proposals cannot bypass approval, leases or receipt reconciliation | Security gate and uncertain-outcome tests before rollout |
| P0 | Protected original `C:\Users\SAMPATH\.operator` | Uncertain recovery state documented separately | Production recovery not certified | Never mutate original receipts, force release, or replay until independently accepted |

## Answers to audit questions

1. Natural-language objective is received at POST /v1/tasks alongside a **required typed goal**.
2. Server route calls `TaskOrchestrator.submit`, then optionally `run`.
3. No production model invocation is registered in the observed main.ts TaskOrchestrator composition.
4. TaskOrchestrator owns execution iterations; built-in planners generate typed deterministic decisions.
5. TaskOrchestrator owns lifecycle, durable task state, budgets and verification.
6. The real local-agent entry uses AgentKernel for action execution; alternate test injections exist and do not prove every other entrypoint.
7. Browser provider supplies observations; tested task goals can consume them, but not through a general model.
8. The built-in autonomous-workflow planner selects phases from predefined actions, not arbitrary model actions.
9. Recovery/reobserve and pagination exist, but broad model-generated replanning is not wired.
10. Cancellation, action budgets and per-step protections exist; async planning pause/timeout is addressed here.
11. Verification functions are wired; broad nonbenchmark independent acceptance is still missing.
12. Model decision integration, dynamic goal decomposition, general visual fallback, full coverage and security certification are missing or not verified.

Do not treat mere module presence as a production capability. Re-inspect the source after other contributors merge.
