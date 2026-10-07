# R4 External Human Certification Campaign

This directory defines the fixed study protocol for the R4 program-level exit gate.

The repository implementation is already certified. This campaign answers the remaining human question: can external prepared users complete the primary Mecord workflow quickly, understand approvals/recovery/proof without developer help, and inspect the causal timeline correctly?

## Participant eligibility

A session counts only when all three are true:

- the participant is external to the Mecord implementation team;
- the participant has received the same short preparation brief used for the cohort;
- consent to collect anonymized task-performance data is recorded.

Do not store names, email addresses, account IDs, IP addresses, or other direct identifiers in study JSON. Use random participant IDs.

## Fixed workflow

Each participant performs the same first-use path:

1. install;
2. doctor;
3. authenticate;
4. pair device;
5. configure authorized roots;
6. perform a read probe;
7. complete an approval probe;
8. complete one guided verified task;
9. inspect the resulting proof;
10. explain the causal timeline and recovery categories.

Developer help must be recorded as an assistance event. Do not silently coach a participant and still mark the session assistance-free.

## Approval comprehension

Without opening approval documentation, the participant must correctly identify:

- requested effect;
- scope;
- risk;
- reversibility;
- alternatives;
- exact resource;
- expiry;
- reason.

## Recovery comprehension

The participant must correctly distinguish:

- retryable;
- reconcilable;
- reversible;
- blocked;
- terminal;
- uncertain.

## Proof comprehension

The participant must open the proof and correctly identify:

- who/what authority allowed the action;
- what effect actually occurred;
- how the result was independently verified.

## Default certification standard

The evaluator currently requires:

- at least 5 eligible external prepared participants;
- >=80% primary-workflow completion;
- >=80% assistance-free completion;
- >=90% approval comprehension;
- >=85% recovery comprehension;
- >=80% proof inspection comprehension;
- >=80% causal-timeline comprehension;
- median time-to-first-verified-task <=20 minutes;
- p90 time-to-first-verified-task <=45 minutes.

The exact standard is embedded in source and included in every resulting report. A custom standard may be supplied explicitly, but it becomes part of the report digest and must not be changed after reviewing cohort outcomes.

## Running the evaluator

Create one digest-bound session record per participant using `createR4HumanStudySession`, then place those records in a study JSON document:

```json
{
  "sourceSha": "<exact 40-char source SHA used by every participant>",
  "sessions": []
}
```

Evaluate with:

```bash
npm run evaluate:r4:human-study -- certification/r4/study.json
```

The machine-readable result is written to `artifacts/r4-human-study/report.json`. A `NOT_CERTIFIED` report exits non-zero and explains every missed threshold.

Repository tests may use synthetic cohorts to prove the evaluator works. Synthetic sessions are never acceptable as external certification evidence.
