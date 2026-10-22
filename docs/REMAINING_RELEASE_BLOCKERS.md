# Mecord Connect remaining release blockers — 2026-10-22

**Public autonomous production release: NOT READY.**

| Priority | Blocker | Required evidence |
| --- | --- | --- |
| P0 | Protected original relay unknown execution/reconciliation state | Independent signed owner recovery and authoritative no-replay outcome; separate certification |
| P0 | No general model-driven production planner wired at real user entry point | Bounded privacy-aware model provider, observed-state grounding, user-scoped authority, verified real executions |
| P0 | Natural-language-only POST /v1/tasks cannot derive safe typed contracts | Intent parsing, missing input handling, scoped and observable success conditions |
| P0 | Official benchmark-only controller is not the production agent | Production-runner integration, official 125-task independent baseline, audit |
| P1 | Broad unfamiliar browser/desktop capabilities unaccepted | Fresh observation/visual fallback, action contract and 25 diverse independent real-world tasks |
| P1 | Comprehensive threat model and adversarial tests incomplete | Website/repository injection, forged refs, path, approval, replay and recovery tests |
| P1 | Full production typecheck unavailable in isolated checkout | Restore development dependency and pass compiler with no type errors |
| P1 | Matched performance/cost evaluation not performed | Frozen source/model settings, measured latency/tokens/API spend, per-failure evidence |
| Release | Review, independent security acceptance, deployment gates | Reviewed PRs and release authority; no automatic merge or npm publish |

This branch only addresses the asynchronous planner boundary and pre-dispatch pause/timeout behavior. PR #359 stays separate and draft. No 100%-complete claim.
