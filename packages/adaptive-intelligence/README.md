# Mecord Adaptive Intelligence Core

This package is a dependency-light successor module undergoing progressive integration with Mecord Connect's production `Operator-runtime`.

Observation selection, normalized outcome progress/failure reasoning, and low-risk plan-node recommendation are wired into `TaskOrchestrator` in **SHADOW mode only**. Observation selection can rank already-authorized read-only capabilities; outcome reasoning can classify secret-minimized machine evidence after the authoritative action result; plan-node recommendation can compare capability identities from the current node and verified procedure memory through Verified Plan Runtime hard risk/budget gates. These stages record comparison evidence, but cannot supply executable inputs, dispatch actions, alter planner control flow or durable plan graphs, select recovery, widen authority, or bypass policy, approvals, and resource leases. Repair planning, modality selection, strategy control, browser CDP, UIA, provider routing, and every mutating control path remain deliberately isolated pending later activation stages. The offline/local source successor may contain newer 2.0.5 hardening that must be reconciled before further integration.

## Purpose

The package adds reasoning/control primitives above the existing Mecord execution substrate:

- epistemic state: known / supported / conflicted / stale / unknown / unobservable / disproven;
- causal state transition graph;
- evidence-weighted multi-hypothesis failure attribution;
- action-vs-state-vs-subgoal-vs-goal progress semantics;
- anti-loop strategy ranking;
- counterfactual recovery selection;
- long-horizon trajectory compression;
- generic verified skill schema;
- receipt-gated learning firewall;
- evaluation-frozen and shadow learning modes;
- confidence calibration metrics;
- a standalone `AdaptiveIntelligenceKernel` composition facade.

## Non-negotiable authority boundary

This package never grants authority.

It may consume constraints and evidence and may recommend:

- observe;
- reground;
- replan;
- repair;
- reconcile;
- wait;
- verify;
- fail safe.

It must never:

- expand allowed scope;
- change canonical action risk;
- bypass approval;
- bypass emergency stop;
- mint authority tokens;
- override newest-intent-wins;
- mark an uncertain mutation safe to replay;
- certify its own success without independent verification.

The future data flow is intended to remain one-way:

```
Mecord policy/authority constraints
            |
            v
BoundedTaskIntelligence (retrieval)
            |
            v
AdaptiveIntelligenceKernel (reasoning/recommendation)
            |
            v
TaskOrchestrator
            |
            v
AgentKernel -> authority -> leases -> provider -> reconciliation -> verification
            |
            v
verified evidence / outcome receipts
            |
            +----> adaptive learning (receipt-gated)
```

## Benchmark contamination rule

The package contains no MiniWoB, OSWorld, WebArena, WorkArena, or benchmark-task-specific strategy.

Official evaluations should run with a frozen policy/skill snapshot. `LearningFirewall` blocks promotion in `EVALUATION_FROZEN` and `SHADOW` modes and can reject configured benchmark identifiers before promotion.

## Integration gate

Before merging into production:

1. bring the offline Mecord Deep Hardening laptop online;
2. inspect the actual `codex/deep-hardening` HEAD (known prior state reached at least the 2.0.5 hardening line);
3. compare this package against newer epistemic/reobservation/recovery implementations;
4. delete or adapt duplicates rather than overwriting newer runtime logic;
5. integrate contracts first, then shadow attribution/progress, then recovery selection, then strategy control;
6. keep AgentKernel and existing independent verification authoritative.
