# Mecord Convergence R1-R2 Execution Workstream

Date opened: 2026-10-06  
Base commit: `ed5948ff3f386f91ccd27674ed278a8ba5c624e6`  
Branch: `program/mecord-convergence-r1-r2`  
Roadmap source: `docs/MECORD_GOD_LEVEL_MASTER_BLUEPRINT.md`

## Status

This workstream exists because the R-series roadmap is documented on `main`, but no post-blueprint implementation commit has yet established R1 or R2 as a completed release train.

Nothing in this document is evidence that an R milestone is complete. A milestone is complete only when its implementation, tests, migration evidence, compatibility checks, rollback evidence, and required review gates are present in the repository.

## Objective

Execute the first two maturity releases without colliding with release, deep-hardening, benchmark, or experimental intelligence work:

- **R1 — Canonical Trusted Runtime**
- **R2 — Integrated Adaptive Planning Runtime**

R3+ work is intentionally excluded from this branch until the R1/R2 foundations and promotion gates are satisfied.

## Non-negotiable architecture rules

1. Planning and adaptive intelligence remain advisory above the authority boundary until explicitly promoted through evidence-backed gates.
2. Existing authority, policy, resource lease, reconciliation, and verification kernels remain final runtime authority.
3. No learned behavior, planner output, benchmark result, model confidence, role, or workflow grants authority.
4. Unknown/uncertain effects must be reconciled before retry, replanning, or branch switching.
5. No benchmark-task-name, selector, answer, or benchmark-specific strategy may enter production logic.
6. No rewrite of successful history or unresolved side effects during replanning.
7. Every persistent envelope introduced by this workstream must be versioned and migration-tested.
8. Every cross-branch import records source SHA, invariant impact, tests, and rollback path.
9. No R milestone is marked complete from unit tests alone.
10. Main is updated only through reviewable, regression-backed PRs.

---

# Lane 0 — Current-state reconciliation

Before feature work:

- inventory `main`, `codex/deep-hardening`, release branches, Adaptive Intelligence branches, Verified Plan Runtime branches, and any active integration branches/worktrees;
- identify unique commits and unmerged fixes;
- map ownership of `TaskOrchestrator`, runtime construction, persistent schemas, browser/provider boundaries, release metadata, and CI;
- classify each difference as:
  - already on main,
  - must import,
  - obsolete,
  - experimental,
  - conflicting,
  - audit-only;
- produce a machine-readable reconciliation ledger;
- do not silently cherry-pick overlapping changes.

**Gate L0:** one agreed source map with no unexplained unique production state.

---

# R1 — Canonical Trusted Runtime

## R1.1 Canonical source and release truth

Build one generated release ledger that binds:

- repository commit SHA;
- package versions;
- npm package identity;
- deployment image/artifact digest;
- schema version;
- native helper version;
- release channel;
- migration range;
- rollback target;
- qualification evidence.

Remove hand-maintained version claims where generation is possible.

**Exit proof:** packaged/deployed/documented/registry versions can be derived from one ledger and compared automatically.

## R1.2 Root workspace and strict type boundaries

- establish root workspace/project references;
- type-check all production TypeScript;
- separate package build graphs;
- remove accidental implicit cross-package imports;
- fail CI on contract drift;
- keep generated artifacts outside source-of-truth code.

**Exit proof:** repository-wide production type-check is deterministic and green from a clean checkout.

## R1.3 Contract and schema registry

Create stable, versioned contracts for:

- principal;
- delegation;
- intent;
- goal;
- plan;
- plan node;
- task;
- action;
- attempt;
- authority envelope;
- resource identity and revision;
- lease;
- evidence;
- receipt;
- artifact;
- event;
- evaluation run.

Add compatibility tests for current and previous supported versions.

**Exit proof:** contracts have explicit version/migration/compatibility semantics and no duplicate authoritative identity definitions remain.

## R1.4 Monolith decomposition without behavior change

Prioritize:

- task orchestrator;
- local/server routing;
- browser execution/observation;
- persistence construction;
- runtime lifecycle.

Requirements:

- characterization tests first;
- extract by responsibility, not arbitrary file size;
- no behavior change bundled with extraction;
- no new authority bypass;
- stable public interfaces.

**Exit proof:** high-change boundaries are modular, independently testable, and behavior-equivalent.

## R1.5 CI release lanes

Split qualification into:

- fast PR lane;
- integration lane;
- nightly/fault lane;
- immutable release-candidate lane.

Publish:

- timing;
- flake rate;
- skips;
- platform exclusions;
- failure ownership;
- evidence links.

**Exit proof:** fast feedback does not weaken release certification, and an immutable release candidate is reproducibly qualified.

## R1.6 R1 release evidence

Produce a release Evidence Pack containing:

- source SHA;
- dependency lock identity;
- native helper identity;
- build outputs;
- test/certification results;
- schema compatibility;
- upgrade and rollback proof;
- known limitations;
- unresolved audit findings.

### R1 completion gate

R1 is complete only when:

- one canonical branch can produce every package/deployment artifact;
- production TypeScript is comprehensively type-checked;
- release truth is generated and consistent;
- persistent schemas pass compatibility tests;
- no unexplained laptop-only production state remains;
- qualification and rollback evidence are reproducible;
- open P0 correctness/security findings are either fixed or explicitly release-blocking.

---

# R2 — Integrated Adaptive Planning Runtime

R2 starts only after the R1 identity/contract foundation is merged or stable enough to build against.

## R2.1 Canonical execution identity graph

Introduce a single immutable execution context identity that can bind:

- account;
- device;
- session;
- conversation;
- intent + intent version;
- task;
- goal;
- plan + revision;
- node;
- action;
- attempt;
- authority version;
- resource identity + revision;
- lease/fencing token;
- evaluation run.

Every mutation and verification receipt must be lineage-bound to the exact relevant identities.

**Gate:** no planner/adaptive component invents a parallel identity namespace for authoritative execution.

## R2.2 Core ↔ intelligence adapters

Build explicit adapters between:

- runtime observations/evidence and adaptive epistemic state;
- runtime task/goal structures and verified plan contracts;
- runtime verification receipts and plan-node outcome contracts.

The adapters must define source precedence and conflict handling.

**Gate:** no second world model and no second verification authority.

## R2.3 Shadow decision/outcome envelope

Emit bounded, privacy-safe events from authoritative runtime decisions.

Allowed shadow data should prefer:

- identifiers;
- classifications;
- bounded summaries;
- hashes/digests;
- timings;
- decision codes;
- verifier outcomes.

Do not persist unrestricted:

- credentials;
- environment variables;
- raw terminal payloads;
- full DOM dumps;
- arbitrary file contents;
- private prompts/secrets.

Add:

- retention;
- sampling;
- per-session enablement;
- kill switch;
- compaction;
- deterministic replay where applicable.

## R2.4 Observation-only intelligence

Run Adaptive Intelligence and Verified Plan Runtime in shadow mode:

- they may observe;
- they may produce recommendations;
- they may not change authoritative action selection;
- control vs shadow outcomes are compared on frozen cohorts.

Measure:

- false completion;
- repeated equivalent failure;
- loop frequency;
- recovery quality;
- calibration;
- latency;
- CPU/memory/state growth.

## R2.5 Advisory mode

After shadow evidence is credible:

Adaptive Intelligence may recommend only closed commands such as:

- `OBSERVE`
- `REGROUND`
- `REPLAN`
- `REPAIR`
- `RECONCILE`
- `WAIT`
- `VERIFY`
- `FAIL_SAFE`
- user escalation

Verified planning may rank read-only or non-mutating next steps.

The authoritative runtime may reject every recommendation.

## R2.6 Reversible canary control

Only after promotion thresholds:

- allow ordering of low-risk reversible actions;
- require exact authority/resource envelopes;
- require checkpoint/rollback;
- require independent postcondition verification;
- canary by capability;
- immediate kill switch and planner rollback.

## R2.7 General bounded control

General control requires:

- at least 10,000 representative non-benchmark shadow decisions;
- statistically defensible verified-outcome improvement;
- zero demonstrated authority expansion caused by the new planners;
- zero unsafe replay attributable to new planning/adaptive state;
- deterministic restart with identical state digests;
- bounded reconciliation latency;
- acceptable added latency/CPU/memory/storage;
- rollback to the prior planner snapshot.

High-risk or irreversible actions continue to require fresh production authority and explicit approval/policy receipts.

### R2 completion gate

R2 is complete only when intelligence improves independently verified outcomes while the trusted runtime retains hard veto authority and can revert immediately to the prior control path.

---

# Commit/PR workflow

Use small invariant-scoped PRs. Recommended order:

1. reconciliation ledger;
2. release truth ledger;
3. strict workspace/type foundation;
4. contract/schema registry;
5. identity graph;
6. characterization tests + modular extraction;
7. shadow event envelope/store;
8. adaptive/core adapters;
9. verified-plan/task adapters;
10. frozen evaluation cohorts;
11. advisory mode;
12. reversible canary;
13. promotion decision.

Every PR must state:

- source/base SHA;
- invariant affected;
- persistent schema impact;
- rollback method;
- targeted tests;
- full-suite impact;
- concurrency conflicts;
- evidence produced.

Do not bundle unrelated fixes simply to reduce PR count.

# Progress ledger

Track each item as exactly one of:

- `NOT_STARTED`
- `IN_PROGRESS`
- `BLOCKED`
- `IMPLEMENTED_NOT_CERTIFIED`
- `CERTIFIED`

Never use `DONE` without the relevant exit proof.

Initial state:

| Work item | Status |
|---|---|
| Lane 0 reconciliation | NOT_STARTED |
| R1.1 release truth | NOT_STARTED |
| R1.2 strict workspaces/types | NOT_STARTED |
| R1.3 contract/schema registry | NOT_STARTED |
| R1.4 modularization | NOT_STARTED |
| R1.5 CI lanes | NOT_STARTED |
| R1.6 R1 Evidence Pack | NOT_STARTED |
| R2.1 execution identity graph | NOT_STARTED |
| R2.2 intelligence adapters | NOT_STARTED |
| R2.3 shadow envelope/store | NOT_STARTED |
| R2.4 observation-only intelligence | NOT_STARTED |
| R2.5 advisory mode | NOT_STARTED |
| R2.6 reversible canary | NOT_STARTED |
| R2.7 general bounded control | NOT_STARTED |

# Explicitly out of scope for this branch

Until R1/R2 gates are met, do not begin:

- R3 Workspace Graph productization beyond contract preparation;
- new marketplace work;
- distributed compute mesh;
- counterfactual twin;
- proof-kernel research implementation;
- dynamic capability synthesis;
- broad macOS/Linux GUI parity;
- marketing claims that R1 or R2 are complete.

# Definition of success

This workstream succeeds when Mecord moves from a powerful collection of trusted/autonomous components to one canonical runtime in which planning and adaptive intelligence are integrated through explicit identities, contracts, evidence, promotion gates, and rollback — without weakening authority, verification, privacy, or recovery guarantees.
