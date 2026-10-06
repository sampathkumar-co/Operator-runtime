# R1 / R2 / R3 Closeout Ledger

Certification subject: `9f55093d1e8c93fe9b51db0251c4184c2ede4c9a`

Convergence branch: `program/r1-r3-closeout-20261006`

This ledger distinguishes implementation completion from roadmap certification. Workflow success proves code, integration and release qualification for the pinned subject; it cannot substitute for an explicitly empirical roadmap gate.

| Release | Status | Closeout |
| --- | --- | --- |
| R1 — Canonical Trusted Runtime | **CERTIFIED** | Canonical source, release truth, strict production type graph, contract/schema compatibility, decomposition, CI lanes and immutable release evidence are qualified. |
| R2 — Integrated Adaptive Planning Runtime | **IMPLEMENTED_NOT_CERTIFIED** | Shadow → advisory → reversible canary → bounded general control implementation is qualified. GENERAL promotion remains fail-closed until the required real representative non-benchmark evidence satisfies the empirical exit gate. |
| R3 — Developer Workstation OS | **CERTIFIED** | Workspace graph, durable developer session, semantic/code intelligence, transactional editing + rollback, hermetic execution and evidence-pack lifecycle are qualified cross-platform. |

## Qualification evidence for the pinned subject

- R1 Canonical Runtime — run `37495183715` — **success**
- R2 Adaptive Planning Runtime — run `37495183718` — **success**
- CI — run `37495183741` — **success**
- Platform Matrix — run `37495183707` — **success** on Ubuntu, macOS and Windows
- NPM Remote Runtime CI — run `37495183802` — **success**
- Windows Signing Smoke — run `37495183772` — **success**

## R2 empirical boundary

R2 production GENERAL promotion requires real frozen representative evidence. The implementation enforces, among other checks:

- at least 10,000 representative non-benchmark shadow decisions;
- at least 1,000 representative tasks;
- defensible independently verified outcome improvement;
- no increase in false completion or repeated equivalent failure;
- no reduction in recovery success;
- zero authority expansion;
- zero unsafe replay attributable to adaptive control;
- deterministic restart;
- rollback proof and independent verification receipts;
- exact frozen evaluation lineage / manifest / criteria binding.

Synthetic tests certify the enforcement mechanism. They do not count toward that empirical threshold.

## Certification ledgers

- `docs/R1_CANONICAL_RUNTIME_CERTIFICATION.md`
- `docs/R2_ADAPTIVE_PLANNING_CERTIFICATION.md`
- `docs/R3_DEVELOPER_WORKSTATION_CERTIFICATION.md`

Runtime source certification remains pinned to `9f55093d1e8c93fe9b51db0251c4184c2ede4c9a`. Later documentation-only ledger commits do not expand the certified runtime source.
