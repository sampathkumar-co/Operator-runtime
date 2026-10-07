# R1 / R2 / R3 Closeout Ledger

Certification subject: `9f55093d1e8c93fe9b51db0251c4184c2ede4c9a`

Convergence branch: `program/r1-r3-closeout-20261006`

This ledger distinguishes implementation completion from roadmap certification. Workflow success proves code, integration and release qualification for the pinned subject; it cannot substitute for an explicitly empirical roadmap gate.

| Release | Status | Closeout |
| --- | --- | --- |
| R1 — Canonical Trusted Runtime | **CERTIFIED** | Canonical source, release truth, strict production type graph, contract/schema compatibility, decomposition, CI lanes and immutable release evidence are qualified. |
| R2 — Integrated Adaptive Planning Runtime | **CERTIFIED** | Shadow → advisory → reversible canary → bounded general control is qualified, and the frozen 1,000-task / 11,718-decision non-benchmark empirical promotion gate passed with independently verified improvement, zero authority expansion, zero unsafe replay, deterministic restart and verified rollback. |
| R3 — Developer Workstation OS | **CERTIFIED** | Workspace graph, durable developer session, semantic/code intelligence, transactional editing + rollback, hermetic execution and evidence-pack lifecycle are qualified cross-platform. |

## Qualification evidence for the pinned subject

- R1 Canonical Runtime — run `37495183715` — **success**
- R2 Adaptive Planning Runtime — run `37495183718` — **success**
- CI — run `37495183741` — **success**
- Platform Matrix — run `37495183707` — **success** on Ubuntu, macOS and Windows
- NPM Remote Runtime CI — run `37495183802` — **success**
- Windows Signing Smoke — run `37495183772` — **success**

## R2 empirical certification

Certification subject: `9221c58d7efd0165ac66ea61ec0e4e11cf983d87`

- R2 Empirical Certification — run `37503427134` — **success**
- 1,000 representative non-benchmark historical-development tasks
- 11,718 paired candidate/control decisions
- candidate verified success: 100%
- control verified success: 93.8%
- paired candidate-only wins: 62; control-only wins: 0
- exact paired sign-test p-value: 2.168404344971009e-19
- zero authority expansion
- zero unsafe replay
- deterministic restart verified
- rollback verified
- GENERAL promotion accepted by the core promotion gate
- no paid model/API/service calls

Evidence path: `evidence/r2/9221c58d7efd0165ac66ea61ec0e4e11cf983d87/`

## Certification ledgers

- `docs/R1_CANONICAL_RUNTIME_CERTIFICATION.md`
- `docs/R2_ADAPTIVE_PLANNING_CERTIFICATION.md`
- `docs/R3_DEVELOPER_WORKSTATION_CERTIFICATION.md`

Runtime source certification remains pinned to `9f55093d1e8c93fe9b51db0251c4184c2ede4c9a`. Later documentation-only ledger commits do not expand the certified runtime source.


## Final R1–R3 status

R1: **CERTIFIED**

R2: **CERTIFIED**

R3: **CERTIFIED**
