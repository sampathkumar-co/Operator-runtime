# R2 Integrated Adaptive Planning Runtime Certification

Status: **CERTIFIED**

Branch: `program/r1-r3-closeout-20261006`

R2 code paths are implemented through general bounded control and the empirical roadmap exit gate has now been satisfied for certification subject `9221c58d7efd0165ac66ea61ec0e4e11cf983d87`. The certification used a frozen non-benchmark historical-development replay cohort, independent postcondition receipts, exact lineage binding, and no paid external model/service calls.

## R2.1 Contract integration

Implemented:
- canonical `ExecutionContextIdentity`;
- core/adaptive/verified-plan adapters;
- closed recommendation vocabulary;
- contract registry entries for durable control state and promotion evidence.

## R2.2 Shadow observation

Implemented:
- bounded metadata-only shadow decision store;
- no raw action output, credentials, unrestricted DOM, or file contents;
- verified-plan shadow wrapper with no dispatch path;
- state digests suitable for deterministic replay/restart comparison.

## R2.3 Advisory production

Implemented:
- explicit `ADVISORY` mode;
- advisory recommendations cannot alter action order;
- all decisions state `grantsAuthority: false` and require the authoritative runtime veto.

## R2.4 Reversible canary

Implemented:
- exact-proposal binding;
- read/write-only canary influence;
- mandatory reversibility, checkpoint, rollback, authority digest, resource revision, fence token, and independent verification;
- stale recommendations fail closed before provider dispatch.

## R2.5 General bounded control

Implemented:
- bounded planner veto/replan/repair/reobserve path;
- existing planner remains the only action proposal source;
- the adaptive hook can defer, fail safe, escalate, reconcile, or return control to the existing planner;
- it cannot invent an action, grant permissions, alter canonical risk, or bypass provider/runtime verification;
- high-risk or irreversible influence requires fresh explicit user/policy authority receipt.

## Promotion gate

`GENERAL` promotion requires:
- at least 10,000 representative shadow decisions;
- at least 1,000 representative non-benchmark tasks;
- benchmark contamination excluded;
- statistically defensible verified-outcome improvement;
- no increase in false completion or repeated equivalent failure;
- no reduction in recovery success;
- zero authority expansion;
- zero unsafe replay;
- deterministic restart proof;
- rollback snapshot;
- independent verification receipts;
- frozen evaluation lineage, candidate/baseline manifest and promotion-criteria digests.

The bridge is implemented in `scripts/derive-r2-promotion-evidence.ts`. It validates the existing Adaptive Intelligence frozen promotion bundle, rejects benchmark-tagged cohorts, refuses weakened GENERAL thresholds, binds operational rollback/replay evidence to the exact evaluation lineage, and only then emits the evidence shape accepted by the core runtime promotion gate.

## Empirical certification record

Certification subject: `9221c58d7efd0165ac66ea61ec0e4e11cf983d87`

Empirical qualification:
- R2 Empirical Certification — run `37503427134` — **success**
- representative tasks: **1,000**
- paired shadow/control decisions: **11,718**
- candidate independently verified task success: **1,000 / 1,000**
- control independently verified task success: **938 / 1,000**
- candidate-only paired wins: **62**
- control-only paired wins: **0**
- verified task-success delta: **+6.2 percentage points**
- decision-level verified-outcome delta: **+0.039427**
- exact paired sign-test p-value: **2.168404344971009e-19**
- benchmark contamination: **none**
- paid external services/models: **none**
- authority expansion: **0**
- unsafe replay: **0**
- deterministic restart: **verified**
- rollback to prior planner state: **verified**
- promotion mode accepted by the core gate: **GENERAL**

Evidence is persisted under:
`evidence/r2/9221c58d7efd0165ac66ea61ec0e4e11cf983d87/`

The empirical workflow independently validates the frozen candidate/baseline manifests, cohort digest, shadow comparison, calibration, promotion criteria, lineage digest, verification receipts, restart proof and rollback proof before accepting certification.

## Implementation qualification record

Qualification subject: `9f55093d1e8c93fe9b51db0251c4184c2ede4c9a`

Implementation qualification:
- R2 Adaptive Planning Runtime: **success** — run `37495183718`
- R1 Canonical Runtime dependency boundary: **success** — run `37495183715`
- CI: **success** — run `37495183741`
- Platform Matrix (Ubuntu/macOS/Windows): **success** — run `37495183707`
- NPM Remote Runtime CI: **success** — run `37495183802`
- Windows Signing Smoke: **success** — run `37495183772`

This proves the R2 implementation and trusted-runtime integration. The separate empirical certification above satisfies the roadmap exit gate for subject `9221c58d7efd0165ac66ea61ec0e4e11cf983d87`.

R2 is therefore **CERTIFIED**. Future runtime changes that affect adaptive planning, authority, verification, replay, recovery, or promotion semantics require a fresh empirical certification rather than inheriting this status automatically.
