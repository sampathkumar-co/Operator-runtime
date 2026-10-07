# R6 External Ecosystem Certification Campaign

R6 repository implementation is already green. This campaign is the fixed program-level acceptance gate for the remaining ecosystem claims.

## Independent integrations

Certification requires at least three qualifying integrations with:

- three distinct external publisher identities;
- three distinct external agent ecosystems;
- at least two integration surfaces among TypeScript SDK, Python SDK, OpenAPI, and webhook;
- no Mecord core changes required;
- conformance suite pass;
- adversarial suite pass;
- unsafe capability/provider denial proven;
- at least one evidence artifact per integration;
- exactly the same canonical authority/effect/resource/evidence trust semantics digest.

Integrations written by the Mecord implementation team do not count as external evidence.

## Public publisher lifecycle

At least one independently tested publisher must demonstrate the full capability lifecycle:

1. signed package;
2. reproducible build metadata;
3. publish;
4. observed quality metrics;
5. revoke;
6. revocation propagation;
7. execution denied after revocation.

The publish/monitor/revoke lifecycle must carry at least three SHA-256 evidence artifacts.

## Evaluation

Store only bounded publisher/integration identifiers and evidence digests in the campaign record. Do not store third-party credentials or signing secrets.

Evaluate with:

```bash
node --experimental-strip-types scripts/evaluate-r6-external-ecosystem.ts certification/r6/campaign.json
```

Synthetic examples are valid only for testing the evaluator. Program-level R6 certification requires genuinely independent external integrations.
