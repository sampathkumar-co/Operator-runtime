# Wave 0: source coding reconciliation (2026-10-27)

**Purpose:** reconcile C00/C01 checked and unchecked work against existing merged source, and implement missing reusable source validation. This is **not** an evaluation result, physical acceptance, or npm release.

## C00 source truth

| Item | Source status | Exact limitation |
| --- | --- | --- |
| C00-01 | EXISTING SOURCE/MANIFEST | Stable 2.0.6 package and native helper evidence is pinned, not current candidate certification. |
| C00-02 | EXISTING SOURCE | `scripts/c00-source-operation-inventory.ts` inventories provider claims, not actual physical behavior. |
| C00-03 | EXISTING SOURCE | Historical #359 benchmark-control integration excluded, #342 needs measured comparison, #368 source-only adaptations. |
| C00-04 | EXISTING SOURCE | 11 legacy defects classified, not all repaired or independently accepted. |
| C00-05 | EXISTING SOURCE | Release-truth docs exist; current candidate remains unreleased. |
| C00-06 | NEW READ-ONLY AUDITOR / ORIGINAL EVIDENCE NOT RUN | `scripts/c00-local-source-provenance.mjs` can pseudonymously hash *explicitly selected* files, refusing protected `.operator`, secret destinations, unsafe symlink aliases and traversal. No lost historical controller has been recovered, no source ownership or provenance was independently authenticated. |
| C00-07 | EXISTING SOURCE-PINNED CI | Native/helper/doctor and platform qualification pertains to the stable pinned SHA, not this Wave 0 branch. |
| C00-08 | EXISTING SOURCE | Versioned intent, goal, action, observation, verification and authority contracts. |
| C00-09 | EXISTING CI GATE | PR evidence contract including physical NOT_RUN and exact head. |

## C01 evaluation lanes and campaign

| Item | Source status | Exact limitation |
| --- | --- | --- |
| C01-01 | EXISTING IMPLEMENTATION + HARDENING | `scripts/c01-frozen-model-lane-a.mjs`, `scripts/c01-lane-a-frozen-observations.mjs`, and `src/core/frozen-model-decision-lane.ts` implement model-only frozen-observation evaluations. No genuine external model campaign claimed. |
| C01-02 | EXISTING IMPLEMENTATION | Independent fixed-action Lane B oracle scripts and partial real device evidence; not all scenarios. |
| C01-03 | EXISTING IMPLEMENTATION + HARDENING | `scripts/c01-paired-lane-c.mjs` runs matched model/provider/direct-tool callback pairs, bounded reset/dispatch/oracle. External callbacks are **caller-attested** until independently authenticated. |
| C01-04 | NEW SOURCE CONTRACT / EXTERNAL PIN REQUIRED | `scripts/c01-frozen-campaign-manifest.mjs` requires exact source SHA, dataset revision, exactly 125 unique task IDs, >=3 frozen seeds, model versions/prompts, budgets, fixture and oracle hashes. It cannot itself authenticate or provision BrowserGym/MiniWoB assets. |
| C01-05 | EXISTING SOURCE CLASSIFICATION | Historical 102/125 controller results cannot independently be reproduced and do not prove 2.0.6+ behavior. |
| C01-06 | EXISTING SOURCE CONTRACT + HARDENING | Reporter categories model/schema/grounding/action/policy/transport/verifier/timing/uncertain-side-effect/unattributed. Independent *actual* diagnosis still requires real evidence. |
| C01-07 | EXISTING JSONL/SHA WRITER + HARDENING | `scripts/c01-sanitized-stepwise-trace.mjs` stores strictly redacted events and scorer digest; the writer does not sign independent physical outcomes. |
| C01-08 | EXISTING 50-CANDIDATE CATALOGUE + SEALED RUNNER / FIXTURES NOT PROVISIONED | `certification/wave0/realistic-journey-candidates-v1.json` is public `SPEC_ONLY_NOT_EXECUTABLE`. `src/core/c01-realistic-journey-runner.ts` requires a **separately sealed external 50-case fixture and independent scorer**. Never substitute the public catalogue for held-out real tasks. |
| C01-09 | SOURCE AGGREGATOR + NEW MANIFEST / CAMPAIGN NOT RUN | Preregistered seeds, Wilson 95% confidence, false completions, human interventions, stage failures, p50/p95 and model-cost counters exist. No additional real model observations or independent holdout are inferred. |
| C01-10 | EXISTING SOURCE + HARDENING | Empty evaluation reports remain `NOT_RUN`, release `NOT_ACCEPTED`. `REPORTED_FULL_COVERAGE_UNVERIFIED` is deliberately not physical certification. |

## This coding consolidation

- Added shared dense, own-data fixture validation for both Lane A implementations, Lane C and sanitized traces. No sparse-array `map`/`every` shortcuts or getter-backed data can be used to fabricate evaluated cases.
- Hardened both the campaign summary and direct run receipt validator against executable and sparse evidence.
- Added reproducible 125-task campaign registration with model/seed/budget/prompt and environment identity; no default model spend or external provider dispatch.
- Added deliberately non-destructive local-only source inventory and adversarial tests, without touching original-device `.operator`.
- Added source-only regression tests for all new contracts. CI results must be read from the exact final PR head, not a historical run.

## Residual acceptance and work boundaries

**Wave 0 source coding** may be reviewed and integrated after exact-head CI; **Wave 0 evidence acceptance remains open** without a separately provisioned 50-journey holdout, real Lane A/C model trials, authenticated physical scoring, original-device unique-code review, and controlled 125-task benchmarks.

Do not change the public nine-tool surface, deploy the runtime, erase or inspect protected recovery receipts, run the external benchmark controller inside product code, or claim a successful new RC through this source-only change.
