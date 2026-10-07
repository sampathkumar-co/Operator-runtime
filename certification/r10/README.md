# R10 Empirical Outcome Certification Campaign

R10 repository implementation is already green. This protocol defines the final program-level empirical comparison against direct tool access.

## Prerequisite release evidence

The campaign must include certified report digests for R1 through R9. Missing or non-certified prior-release evidence fails the final gate.

## Paired cohort design

Run at least 30 paired objectives across at least six representative engineering categories.

Each pair must bind the same:
- objective definition;
- reproducible starting state;
- environment;
- verification rubric.

The rubric must be frozen before either arm runs. The independent verifier must be blinded to whether the result came from direct tool access or Mecord R10.

Each pair runs:
1. a direct-tool-access baseline arm;
2. a Mecord R10 arm on the exact certification source SHA.

Use the same verifier for both arms of a pair. At least three verifier identities must participate across the cohort.

Execution order must be counterbalanced: at least 10 baseline-first pairs and at least 10 R10-first pairs.

## Raw observations, not summary claims

The evaluator derives all certification metrics from per-objective observations:
- independently verified task success;
- false completion;
- whether human intervention was required;
- human intervention minutes;
- interruption and recovery;
- authority violations;
- portable proof;
- predicted success probability for uncertainty calibration;
- rollback requirement and success;
- learning-policy violations.

At least 10 R10 observations must include interruption/recovery and at least 10 must require rollback.

Every arm and every pair must carry content-addressed evidence artifacts.

## Minimum R10 standard

The campaign may use stricter thresholds, but never weaker ones. The repository minimum is:
- verified success: at least +5 percentage points over baseline;
- false completion: at least 25% relative reduction and strictly lower than baseline;
- human-intervention rate: at least 20% relative reduction and strictly lower than baseline;
- mean intervention minutes: at least 20% lower when baseline intervention time is non-zero;
- interruption recovery: at least 98%;
- authority violations: 0;
- portable proof coverage: at least 99%;
- uncertainty calibration error: at most 10%;
- rollback success: at least 99%;
- learning-policy violations: 0.

## Evidence safety

Campaign files contain bounded identifiers, numeric observations, and SHA-256 digests. Do not store model/provider credentials, bearer tokens, signing keys, private user data, or hidden benchmark answers.

## Evaluation

Evaluate a completed cohort with:

```bash
node --experimental-strip-types scripts/evaluate-r10-empirical-outcomes.ts certification/r10/campaign.json
```

The machine-readable report is written to `artifacts/r10-empirical-outcomes/report.json`.

Synthetic cohorts are permitted only to test the evaluator. They are not empirical certification evidence.
