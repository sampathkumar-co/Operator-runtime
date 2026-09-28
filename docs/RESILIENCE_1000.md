# Mecord 1,000-Case Resilience Gate

Status: active on `evolution/stage1-20-hardening`.

## Why this exists

Mecord presents one coherent user conversation while internally compiling intent into durable work, selecting disposable intelligence workers, executing through bounded authority, and independently verifying reality. The architecture must remain safe and explainable even when user intent changes, context is stale or conflicting, workers disagree, providers drift, events are duplicated, devices disconnect, or a side effect becomes uncertain.

This gate is deliberately defensive. It is executed through deterministic tests, mocks, fixtures, replay, simulation, staging, and sandboxed fault injection. It is not permission to run disruptive experiments against production systems.

## Permanent invariants

1. Newest valid user intent dominates older intent.
2. Workers cannot expand their own authority.
3. Hypotheses cannot authorize irreversible execution.
4. Model confidence never grants permission.
5. Workers receive minimum necessary context.
6. Workers cannot directly mutate canonical conversation state.
7. Uncertain side effects require reconciliation before retry.
8. Mutations remain idempotent across retries, reconnects, and duplicate delivery.
9. Completion requires independent verification.
10. Reasoning, authority, execution, and verification stay separate.
11. A bad worker has bounded blast radius.
12. Provider loss is recoverable.
13. Long-running work survives process/device failure.
14. Privacy/security restrictions override optimization.
15. Learning may optimize behavior but cannot increase authority.
16. Consequential actions have a reconstructable causal chain.
17. Money, token, time, retry, and action budgets remain bounded.
18. Parallel mutation is coordinated by resource ownership and revisions.
19. The user experiences one coherent conversation.
20. User-facing explanations expose relevant decisions/evidence rather than internal worker chatter.

## Construction

The executable source of truth is `src/core/resilience-matrix.ts`.

The gate is the Cartesian product of:

- **40 distinct failure families**
- **25 independent stress conditions**

That produces exactly **1,000 stable scenarios** named `Fxx-Myy`.

The 40 failure families cover: ambiguous intent; intent reversal; new/contradictory constraints; scope creep; proxy-goal substitution; conversation reference errors; context poisoning, contradiction, staleness, omission, overexposure, provenance loss, and contamination; worker hallucination and overconfidence; capability-routing mistakes; correlated/echo failures; provider drift/replacement; graph decomposition, missing dependencies, cycles, and runaway planning; concurrent/stale ownership; duplicate delivery; uncertain side effects; failed compensation; malformed tool results; authority escalation; approval confusion; false verification; budget/latency runaway; learning corruption; audit failure; and infrastructure loss.

The 25 stress conditions apply those families under: first interaction; very long conversation; live user interruption; immediately before/after mutation; worker/device concurrency; cross-device migration; process crash; network partition; provider timeout; partial tool failure; duplicate/reordered/replayed events; huge/minimal/conflicting/expired context; restricted data; nearly exhausted money/time budgets; local-only operation; model upgrades; and high-consequence work.

## Executable enforcement

`security/resilience-1000.test.ts` proves that:

- exactly 1,000 unique scenarios exist;
- every family/modifier pair exists once;
- all scenarios are simulation/sandbox only;
- every scenario binds to constitutional invariants and required controls;
- all 20 invariants receive broad coverage;
- high-consequence work requires fail-closed policy, heterogeneous verification, and action-bound approval;
- uncertain side effects require reconciliation instead of blind retry;
- restricted data requires sovereignty-aware routing and minimum context;
- live user-intent changes require intent revalidation;
- parallel workers require resource leases and revision checks;
- replayed historical actions require idempotency, action binding, and freshness.

The normal red-team runner executes every `security/*.test.ts`, so this gate is part of:

```bash
npm run test:red-team
npm run qualify
```

## Certification levels

A scenario can be in one of three states:

1. **Contract-covered** — the matrix specifies the invariants and controls that must hold.
2. **Implementation-backed** — one or more real runtime tests prove the relevant subsystem behavior.
3. **End-to-end certified** — the complete scenario has been exercised safely in a controlled environment with evidence.

The matrix itself makes all 1,000 cases contract-covered. It does **not** falsely claim that 1,000 disruptive production experiments have been run.

Stage-20 release certification should progressively bind implementation tests and controlled end-to-end evidence to scenario IDs, especially the critical families F29/F30/F32/F33/F34/F35/F40 and high-consequence modifier M25.

## Release rule

No future feature may weaken an invariant to improve convenience, speed, model success rate, or automation depth. A new capability must either satisfy the existing matrix or extend it with a new distinct family/condition when it introduces a genuinely new failure mode.
