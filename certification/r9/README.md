# R9 Physical Multi-Machine Certification Campaign

R9 repository implementation is already green. This protocol defines the remaining real physical-fabric acceptance evidence.

## Physical topology

Certification requires at least two distinct physical machines. Multiple workers or processes on one machine do not satisfy the gate.

Every participating physical machine must:
- run the exact certification source SHA;
- have a unique machine ID and runtime instance ID;
- bind a hardware-attestation digest;
- preserve at least one content-addressed machine evidence artifact.

## Objective workload

Run one objective distributed across at least 20 work units with at least two workers.

Every verified work unit must be independently verified on another physical machine. Required rates:
- verified work-unit rate: 100%;
- causal lineage coverage: 100%;
- artifact recovery coverage: 100%.

The final objective must independently verify.

## Isolation and authority invariants

The campaign must prove:
- artifact-only cross-worker exchange;
- zero raw-secret exchanges;
- monotonic lease epochs through replacement/recovery;
- zero accepted stale results;
- zero unfenced resource conflicts.

## Required fault injection

All nine classes must be deliberately exercised, recover, and carry content-addressed evidence:
- worker disconnect;
- worker crash;
- worker replacement;
- lease expiry;
- resource conflict;
- control-plane restart;
- stale result;
- network partition;
- duplicate delivery.

Across those campaigns the required totals are exactly:
- split-brain execution: 0;
- duplicate execution: 0;
- authority violation/dilution: 0;
- evidence loss: 0.

## Evidence safety

Store only bounded machine/campaign identifiers and SHA-256 digests. Do not put credentials, signing keys, bearer tokens, raw device identifiers, or secret material in the campaign file.

Evaluate with:

```bash
node --experimental-strip-types scripts/evaluate-r9-physical-fabric.ts certification/r9/campaign.json
```

Synthetic tests validate the evaluator only. Program-level R9 certification requires observations from real physical machines.
