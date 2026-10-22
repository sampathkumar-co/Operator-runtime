# Production AI architecture — incremental design

User task -> local-agent POST /v1/tasks -> explicit scoped goal -> TaskOrchestrator -> planner.next -> decision schema -> canonical risk/policy -> AgentKernel -> canonical provider -> observed result -> TaskPlanner.accept -> task verification -> persisted task result.

## Current verified boundary

`src/core/task-orchestrator-contracts.ts`: `TaskPlanner.next` and `repair` now accept synchronous or asynchronous typed decisions. `TaskPlannerContext.signal` conveys cancellation, **not authority**.

`src/core/task-orchestrator.ts`: `boundedPlannerCall` enforces a 30,000-ms maximum for one decision, constrained further by remaining task time. Late responses are discarded. A Pause aborts only the pre-dispatch planning controller. Cancel uses the existing task-wide abort. The model cannot turn a decision into a tool call without the existing validator, scoped risk resolution and production AgentKernel path.

## Proposed next increment (not yet implemented)

1. Resolve natural-language intent to an explicit user-approved task contract and scope.
2. Supply fresh bounded semantic/visual observations to a provider-independent structured model interface; redact secrets before any off-device model.
3. Permit only observed references and allowed action schemas. Never treat web text, repo files or model output as authorization.
4. Compile tentative subgoals into durable plans, with separate read-only verification assertions and cost/step budgets.
5. Use explicit rejection and bounded replanning for stale or ambiguous targets; preserve post-dispatch uncertainty without retries.
6. Expose reasoning/usage telemetry and real evidence through the existing task journal and verified terminal state.

No AI model, credentials, paid endpoint or benchmark-only controller has been connected to production in this increment.
