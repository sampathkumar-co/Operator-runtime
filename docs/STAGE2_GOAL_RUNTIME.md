# Mecord Connect Stage 2 Goal Runtime

Stage 2 moves Mecord from a tool-driven computer bridge toward a bounded autonomous computer operator.

## First implemented vertical slice

The first runtime-expanded goal is `project-quality-gate`.

A caller supplies the outcome-level intent:

- project root
- optional quality checks: `lint`, `test`, `build`
- whether every requested check is mandatory

The runtime then performs the concrete semantic work itself:

1. inspect the authorized project
2. inspect the trusted project-command registry
3. compile the requested/available checks into a deterministic execution plan
4. execute the trusted commands in order
5. retain normal provider postcondition validation
6. record goal-compilation and per-check evidence
7. fail closed when `requireAll` names a missing trusted check

No new MCP tool was added. The goal is submitted through the existing `task.submit` tool, so the Developer surface does not grow merely to expose another primitive.

## Security invariants

Runtime goal expansion does not grant authority. Every compiled action still passes:

- authorized-root checks
- relay capability intersection
- signed session-token scope checks
- local capability policy
- risk resolution and approval/session-grant rules
- emergency stop and cancellation
- provider-specific postconditions
- durable task evidence and execution budgets

The compiler can only choose from already trusted semantic capabilities. It cannot synthesize an arbitrary shell command or expand filesystem scope.

## Next Stage 2 slices

1. project repair loop: reproduce -> diagnose -> bounded patch -> rerun quality gate
2. mutable task DAG with explicit dependencies and appended recovery nodes
3. outcome contracts with machine-checkable completion predicates
4. project intelligence cache for manifests, services, trusted commands, tests and deployment topology
5. provider fallback policy that changes strategy without changing authority
6. independent verification pass before final task completion
7. compact progress/state summaries for ChatGPT so long tasks do not require replaying low-level logs

Stage 3 multi-device scheduling should remain downstream of a reliable Stage 2 single-device operator.
