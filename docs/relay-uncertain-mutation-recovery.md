# Durable relay recovery for uncertain mutations

When an authenticated relay delivery is interrupted, the local agent MUST NOT replay a write merely because its result is missing.

## Delivery recovery order

1. Validate the exact delivery and check the durable result outbox; submit any previously committed result unchanged.
2. For actions, ask the local action receipt endpoint to reconcile with the authoritative kernel journal.
3. If a completed, validated receipt exists, submit that result; do not execute the provider again.
4. If the action is **canonically read-only**, retry it through the normal fresh hosted-generation authorization path.
5. For a validated action that may modify state but has no provably completed result, check fresh hosted account/device/generation authority. Preserve the existing local receipt, or atomically create a protected processing replay fence when it was missing. Persist a bounded **`RELAY_ACTION_OUTCOME_UNCERTAIN`** response in the relay outbox, with `sideEffectState: uncertain` and `retryable: false`. Submit it and ACK the relay only after the hosted result service confirms acceptance.

**An UNKNOWN response is not proof that nothing happened.** The upstream caller must not automatically reissue the mutation with a different action ID. Inspect the protected kernel journal, provider state and original action identity before a new explicit write. Unresolved mutation receipts are retained beyond the old 30-day TTL; exhausting their bounded store fails closed instead of forgetting a replay fence.

Expired delivery history, malformed delivery envelopes, corrupt/contradictory evidence, and unverified account authority remain fail-closed. These cases may still require operator intervention. This design prevents a single ordinary interrupted write from bringing the whole relay down, but does not promise impossible exactly-once semantics for arbitrary browser, filesystem, or external service effects.

## Signed original-device recovery

The existing `scripts/operator-pre-dispatch-recovery.ts` utility (PR #335) provides local-only, interactive, device-signed adjudication for historically stranded actions proven never dispatched. An original PREPARED write requires a process-bound Windows receipt, an independent observation of the exited owner, an exact journal/receipt/device digest and local human no-replay attestation. The utility does not execute the action and is not remotely callable through MCP. Never delete or edit `.operator` to clear an uncertain state.

## Verification and release scope

The fault-injection tests in `test/public-relay-restricted-boundary.test.ts`, `test/action-execution-store.test.ts` and `test/operator-pre-dispatch-adjudication.test.ts` cover both missing and in-progress receipts, verified result submission, no provider re-execution, revoked authority, impossible replay after 90 days and original-host signed recovery. Tests do not authorize deployment. Merge only into a NEW source-matched prerelease branch after platform CI; do not mutate published RC2 provenance, runtime installation, hosted relay or protected state as part of verification.
