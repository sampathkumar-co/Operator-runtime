# R3: Internal-only deferred workspace edit transaction lifecycle

This is a current-main, restricted first slice for verified workspace editing. It does **not** register the old stacked `workspace.edit.verified` provider, change the MCP surface, or turn edit planning into an automatic trusted verifier.

The existing public `execute(action)` path remains an immediate full transaction. Caller-supplied `action.input.deferFinalization` has no effect. Instead, an explicitly constructed trusted in-process orchestrator will eventually call `executeDeferred(action)` to apply and persist exact post-edit hashes in `VERIFICATION_PENDING`, retaining the original backups instead of destroying rollback evidence.

- `finalizeDeferred(action)` is a distinct in-process entry point, callable only after independently certified read-risk verifier success. It validates the action plan/root, exact changed targets and exact original backups before journal transition to `COMMITTED_CLEANUP` and cleanup.
- `rollbackDeferred(action)` likewise requires an exact unchanged held target and backup set, restores original bytes, and records `ROLLED_BACK`. If any target or backup differs, both operations fail closed without silently overwriting it.
- General `reconcile()` returns `uncertain` for a held edit. Restart or target hash equality is **not** proof that trusted verification succeeded; generic reconciliation must not finalize or replay the edit.
- The retained edit's journal is source of truth. The old phase validator is extended to allow `VERIFICATION_PENDING`; all existing public transaction phases and checks remain.
- These internal functions currently share the provider instance's serial queue, but the existing journal's separate-instance/cross-process lock story is **not** newly certified. The next integration step must close that gap and separately register controlled verifier commands before any user-visible workflow.

Tests use real disposable files on CI: preserve backups and hold across provider instance reload, explicit finalization, strict rollback, tampered-post-edit uncertainty, and public input deferral denial. This source-only tranche is NOT the completed verified edit provider and is not a physical-device acceptance.