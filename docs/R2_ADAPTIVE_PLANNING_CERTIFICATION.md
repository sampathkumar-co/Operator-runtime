# R2 Integrated Adaptive Planning Runtime Certification

Status: **IMPLEMENTED_AWAITING_PROMOTION_EVIDENCE**

Branch: `program/r1-r3-closeout-20261006`

R2 code paths are implemented through general bounded control, but production promotion is intentionally fail-closed until the roadmap's real shadow-evidence thresholds are met. Synthetic tests prove the gate; they do not substitute for representative non-benchmark production evidence.

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
- independent verification receipts.

## Remaining certification evidence

R2 must remain **not promoted** until a real frozen cohort satisfies the promotion gate. The repository must not fabricate, benchmark-substitute, or synthetically inflate the 10,000-decision requirement.

The dedicated `R2 Adaptive Planning Runtime` workflow certifies implementation invariants. Production promotion remains a separate evidence decision.
