# R8 Counterfactual Twin and Proof Kernel Certification

Status: **CERTIFIED**

R8 is certified for subject SHA `e8aa52b57fe52605524a091862a836d85bfd02ff`. Repository implementation is qualified by `.github/workflows/r8-counterfactual-proof-kernel.yml`, and the independent acceptance campaign `r8-independent-20261007182436` passed the repository evaluator. The content-addressed campaign manifest is at `certification/r8/evidence/r8-independent-20261007182436/manifest.json`; the evaluator result is at `artifacts/r8-independent-proof/report.json`.

## Work-package coverage

- **R8-FUT-01 Counterfactual digital twin** — content-addressed reconstruction binds repository, dependencies/lockfiles, environment, services, database fixtures, browser state, policy/authority and selected world facts.
- **R8-FUT-02 Alternative-plan evaluation** — deterministic virtual-state simulation compares preconditions, conflicts, blast radius, tests and reversibility before real mutation.
- **R8-FUT-03 Fidelity model** — every reconstruction dimension is explicitly `MODELED`, `PARTIAL` or `ABSENT`; missing dimensions require explicit limitations.
- **R8-FUT-04 Proof vocabulary** — `PROVEN`, `EMPIRICALLY_VERIFIED`, `CORROBORATED`, `INFERRED`, `UNKNOWN`, `CONTRADICTED`.
- **R8-FUT-05 Proof kernel** — deterministic policy, static/type/dependency/invariant/structural evidence, cryptographic receipts, runtime probes, independent tests/verifiers and model inference remain distinct.
- **R8-FUT-06 Proof-carrying execution** — signed bundles bind objective/constraints, exact authority digest, plan lineage, preconditions, action/effect journal, verification evidence, uncertainty and rollback/recovery state.

## Exit-gate proof

The focused R8 suite and the 50-case independent acceptance campaign prove:

1. model inference cannot be promoted to proof;
2. insufficient twin fidelity fails closed;
3. proof bundles can be verified outside the executing runtime using public-key signatures and SHA-256 artifact bytes;
4. tampered bundles or missing/mismatched artifacts fail verification;
5. irreversible execution is denied when uncertainty or proof obligations are unresolved.

The campaign covered five mutation classes using distinct executor and verifier implementations in separate processes. Its verifier independently recomputed proof digests, checked Ed25519 signatures, hashed every referenced artifact, checked postconditions, rejected a tampered bundle per case, rejected ten inference-promotion attempts, and denied ten executions with a deliberately absent required environment dimension. All 40 executed mutations verified with zero residual uncertainty. No signing private key was persisted.

R8 predicts and gates; it does not grant authority. Real execution still requires the R7/R1 authority and lease boundary.
