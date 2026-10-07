# R8 Independent Twin and Proof Acceptance Campaign

R8 repository implementation is already green. This campaign supplies the remaining independent proof/twin acceptance evidence.

## Independent verifier boundary

The verifier must:

- be a distinct implementation from the executor;
- run outside the executing process;
- use a separate verification codepath;
- verify proof-bundle signatures and referenced artifact hashes itself.

Sharing the executing runtime's final boolean is not external verification.

## Case cohort

Run at least 50 cases across at least five mutation classes. Each case must:

- declare required/modelled/absent twin dimensions before execution;
- compare at least two candidate plans;
- bind the selected plan and proof bundle by SHA-256;
- use a verifier identity distinct from the executor identity;
- independently verify signature and artifact hashes;
- reject a tampered proof variant;
- preserve at least one evidence artifact.

For every executed mutation, the postcondition must verify and residual uncertainty must be zero.

## Adversarial proof/fidelity cases

At least 10 cases must deliberately attempt to promote inference to proof; all must be rejected.

At least 10 cases must deliberately omit a required twin dimension and prove that insufficient fidelity prevents unsafe execution. Missing dimensions must also be explicitly declared rather than silently omitted.

## Evidence safety

Campaign records contain bounded identifiers and SHA-256 digests only. Do not store signing private keys, bearer credentials, database secrets, or personal data.

Evaluate with:

```bash
node --experimental-strip-types scripts/evaluate-r8-independent-proof.ts certification/r8/campaign.json
```

Synthetic tests validate this evaluator only. Program-level R8 acceptance requires independently produced proof/twin evidence.
