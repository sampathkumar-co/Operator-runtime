# C08: Source-only original-device recovery review model

This is a deliberately limited, metadata-only coding slice selectively reconciled from old stacked website recovery draft #356, without importing its website mutation routes or older recovery policy ancestry.

## What it provides
- `LocalActionExecutionStore.listOperatorPendingReceipts(limit)`: bounded 1–256, read-only local-store snapshot; waits for local queued writes and reads validated state; returns cloned pending receipt records. It is **not** a cross-process proof or replay authorization.
- `buildOriginalRecoveryReviewModel(receipts, journalEntries)`: pure, bounded projection of historical pending receipts onto one of `REVIEW_REQUIRED`, `FENCED_AWAITING_RECONCILIATION`, `OUTCOME_UNCERTAIN`, or `AUTHORITY_REVIEW_REQUIRED`.
- Duplicate receipt identities throw fail-closed; duplicate or unmatchable journal identities cannot receive a favorable status. An exact `PREPARED → INTERRUPTED` generation-one history produces **awaiting reconciliation**, never permission to replay or an assertion that no side effect occurred.
- The output copies no input, action result, process incarnation, owner identity, authority fingerprint, signer, resource key or full receipt/journal structure. Explanations are static strings. Every row requires independent owner verification; `canApproveOnWebsite` and `websiteApprovalAvailable` are always false.

## Explicitly out of scope
No authentication endpoint or website approval button, no browser/WebAuthn verifier, no state mutation/reconciliation, no automatic retry, no journal repair, no original-device signer, no control relay or external receipt access. User-visible recovery approval must await separately certified authentication, device-bound step-up and original machine evidence. The conservative projection is not an authority decision and cannot be used in the kernel.

## Verification
Synthetic tests cover duplicate/mismatched histories, dispatched uncertainty, privacy, bounded local receipts, immutable durable files, and invalid input refusal. Real original-device validation, cross-process concurrent snapshot testing and physical release acceptance are **NOT_RUN**.