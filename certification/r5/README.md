# R5 Production Operational Certification Campaign

This campaign is the program-level evidence gate above the already-green R5 repository implementation.

A short smoke test is intentionally insufficient. Final certification requires one digest-bound production-like campaign that proves the actual roadmap exit conditions.

## Required topology

- exact tested source SHA recorded;
- PostgreSQL shared control plane;
- at least two relay instances;
- shared durable delivery/result state;
- production-like deployment environment;
- at least 72 hours between campaign start and end.

## Required fault classes

Every class must be deliberately exercised, pass, and carry at least one SHA-256 evidence artifact:

- kill-at-transition;
- network partition/reorder/duplication;
- reboot/sleep/clock drift;
- disk full;
- permission failure;
- corruption;
- large event growth;
- backup during mutation;
- verified restore;
- split-brain worker;
- staged update rollback.

## Minimum SLO floor

The certification evaluator refuses a campaign policy weaker than the repository minimum. The current floor requires, among other controls:

- >=99% verification rate;
- zero false completion;
- <=1% uncertain outcomes;
- >=99.9% crash-free sessions;
- >=99.9% control-plane availability;
- >=99% reconnect success;
- >=99% update success;
- p95 dispatch <=2s;
- p95 verification <=5s;
- zero retention violations.

A deployment may use stricter thresholds.

## Additional required proof

- 100% user-visible operation trace coverage;
- coherent restore;
- safe shared multi-instance state;
- staged update halt/rollback proof;
- at least three external operational evidence artifacts.

Synthetic unit tests prove the evaluator itself only. They are not accepted as operational certification evidence.

Evaluate a completed campaign with:

```bash
node --experimental-strip-types scripts/evaluate-r5-operational-campaign.ts certification/r5/campaign.json
```

The report is written to `artifacts/r5-operational-campaign/report.json` and exits non-zero when any requirement is missing.
