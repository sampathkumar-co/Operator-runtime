# R8 Counterfactual Twin and Proof Kernel Certification

Status: **HISTORICAL_CAMPAIGN_CERTIFIED (source-specific); CURRENT_MAIN_INDEPENDENT_RECERTIFICATION_PENDING**

The historical R8 campaign reported **CERTIFIED for the exact subject SHA** `e8aa52b57fe52605524a091862a836d85bfd02ff`. Its manifest is at `certification/r8/evidence/r8-independent-20261007182436/manifest.json` and its evaluator report is at `artifacts/r8-independent-proof/report.json`. These records are preserved as historical evidence, **not** certification of every later Git commit. Current implementation CI is checked by `.github/workflows/r8-counterfactual-proof-kernel.yml`.

**Current-source distinction (2026-10-08):** The canonical source has advanced past the historical campaign. Audit PR #134 added required out-of-band pinned Ed25519 verifier attestations and actual artifact-byte hashing to the R8/R10 campaign certification gates. The older campaign report does not establish that those newer gates were exercised on the present `main`. Several historical evidence files are referenced by SHA-256 at external `/workspace/certification-lab/r8/...` paths rather than embedded with their bytes in this repository. An independent external verifier must re-collect and sign the campaign evidence against the new exact source SHA before claiming **current-source independent certification**.

## Work-package coverage

- **R8-FUT-01 Counterfactual digital twin** — content-addressed reconstruction binds repository, dependencies/lockfiles, environment, services, database fixtures, browser state, policy/authority and selected world facts.
- **R8-FUT-02 Alternative-plan evaluation** — deterministic virtual-state simulation compares preconditions, conflicts, blast radius, tests and reversibility before real mutation.
- **R8-FUT-03 Fidelity model** — every reconstruction dimension is explicitly `MODELED`, `PARTIAL` or `ABSENT`; missing dimensions require explicit limitations.
- **R8-FUT-04 Proof vocabulary** — `PROVEN`, `EMPIRICALLY_VERIFIED`, `CORROBORATED`, `INFERRED`, `UNKNOWN`, `CONTRADICTED`.
- **R8-FUT-05 Proof kernel** — deterministic policy, static/type/dependency/invariant/structural evidence, cryptographic receipts, runtime probes, independent tests/verifiers and model inference remain distinct.
- **R8-FUT-06 Proof-carrying execution** — signed bundles bind objective/constraints, exact authority digest, plan lineage, preconditions, action/effect journal, verification evidence, uncertainty and rollback/recovery state.

## Historical exit-gate evidence (not current-source recertification)

The focused R8 suite and the archived 50-case campaign report asserted and exercised the following checks for its recorded subject SHA:

1. model inference cannot be promoted to proof;
2. insufficient twin fidelity fails closed;
3. proof bundles can be verified outside the executing runtime using public-key signatures and SHA-256 artifact bytes;
4. tampered bundles or missing/mismatched artifacts fail verification;
5. irreversible execution is denied when uncertainty or proof obligations are unresolved.

The historical campaign report states that it covered five mutation classes using distinct executor and verifier implementations in separate processes. Its verifier independently recomputed proof digests, checked Ed25519 signatures, hashed every referenced artifact, checked postconditions, rejected a tampered bundle per case, rejected ten inference-promotion attempts, and denied ten executions with a deliberately absent required environment dimension. All 40 executed mutations verified with zero residual uncertainty. No signing private key was persisted.

R8 predicts and gates; it does not grant authority. Real execution still requires the R7/R1 authority and lease boundary.
