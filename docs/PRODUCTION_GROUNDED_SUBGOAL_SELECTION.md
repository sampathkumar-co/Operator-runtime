# Observation-grounded local-model subgoal ordering — 2026-10-22

## Production increment

This draft change builds on PR #363, #362, #361, and #360. It implements an actual model-selected decision **inside the production TaskOrchestrator** for the `autonomous-workflow` goal, while still only selecting among the task's **already authorized and dependency-ready** declared subgoals.

Opt-in with `OPERATOR_TASK_SCHEDULER_OLLAMA_MODEL=<already installed local model>`. The default remains the existing deterministic `AutonomousWorkflowPlanner`. The new planner preserves its production planner ID and delegates all step execution and verification logic to that canonical planner.

### Decision contract
- Only evaluate AI scheduling when there are **at least two READY** subgoals, no active subgoal, and a recent (within 120 seconds), successful, unambiguous **schema-v2 KNOWN machine observation**.
- Durable plan dependencies decide which subgoals are READY. The model may only choose one index from this ready set; it **cannot invent/alter actions, tools, inputs, success assertions, scopes, or task identities**.
- The local-model prompt contains only fixed family names of observe/action/verify capabilities, numeric candidate indexes, the last observation channel/domain, and remaining step budget. It never includes task objectives, source files, URLs, paths, user-provided step titles, action arguments, raw screen or DOM text, or credentials.
- Exact loopback Ollama endpoint, redirect prohibition, size-bounded stream, finite 8-second/model task deadline, cancellation propagation and strict `{"index":N}` response schema. Missing model/invalid answer fails closed **before dispatch**.
- The established `AutonomousWorkflowPlanner` executes the selected READY subgoal through existing canonical risk checks, policy and approvals, durable journals, reconciliation and independent read-only verification.
- With no fresh trusted observation or fewer than two READY subgoals, deterministic ordering continues without calling a model.

### Tests
New `test/task-local-model-subgoal-planner.test.ts` covers grounding, stale/uncertain observations, original deterministic behavior, strict no-sensitive-prompt contract, invalid/unapproved selection, extra-field rejection, timeout without side effects and exact delegated predeclared capability.

**Caveat:** The remote Windows device was offline during authoring. Source and tests were published through the private GitHub connector, and CI will provide initial validation. No live Ollama model session, real-world acceptance or official MiniWoB++ benchmark was run.

### Release hold
This is **subgoal order selection**, not fully open-ended browser/desktop action synthesis. Unknown-UI grounded targeting, multi-step verified real-world evaluation, red-team review, original uncertain relay recovery, release acceptance and production deployment remain blocked. No protected user runtime state was accessed.
