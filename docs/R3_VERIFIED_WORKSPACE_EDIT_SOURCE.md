# R3 trusted verifier-gated workspace editing: source-only provider

This tranche selectively ports and repairs unique `VerifiedWorkspaceEditProvider` code from the held historical R3 PR #87, against the newer `WorkspaceEditTransactionProvider` internal deferred APIs merged in #651. It is **not** registered in the shipping local runtime, public MCP tools, default permissions, or the authority kernel.

A deliberately constructed provider:

1. Requires a canonical write-risk `workspace.edit.verified` action and a SHA-bound multi-file edit plan naming 1–50 trusted registered verification commands.
2. Inspects the trusted project command registry BEFORE editing. It refuses missing/ambiguous verifier IDs, declared mutating risk, disallowed long-running/mutating command kinds, and verifier contracts that require changing artifacts.
3. Calls `executeDeferred` (not public `execute`) to make the planned exact edit and retain original backups and the durable pre-dispatch `requiresVerification:true` fence.
4. Runs registered read-declared verifiers. If a verifier fails or Stop is requested, it attempts exact rollback. A verifier lying about mutability and modifying the edited targets blocks both unsafe rollback and unsafe finalization.
5. Only after all verifiers succeed, explicitly calls `finalizeDeferred`, which checks exact target hashes and backup hashes again before recording a completed transaction.
6. On restart, an unchanged held edit can be resumed by the same ID and verifier commands re-run **without reapplying any edit**. Crash during pre-hold APPLYING remains unreconciled/uncertain, never auto-verified. Generic reconciliation can finish a commit that was already explicitly authorized through `COMMITTED_CLEANUP`.
7. Any unexpected error after the internal edit may have started is marked `uncertain`, not `sideEffectState:none`; no implicit retry or arbitrary mutation is authorized.

Tests use disposable project files and a synthetic trusted command registry; they cover success, verifier failure with rollback, mutating-verifier declaration denial, restart/resume, verifier actual source mutation despite read declaration, duplicate verifier identity and changed held targets.

**Still blocked for production:** cross-process exclusive workspace ownership, original-device recovery of interrupted `APPLYING` transactions, externally audited trusted command provenance, full R3 source registration/policy/private tool review, Windows file/path lease physical tests, release/signed package acceptance. Actual command risk declaration is not a mathematical guarantee of no side effects; owner-trusted registry policy and sandbox authority must be certified separately.