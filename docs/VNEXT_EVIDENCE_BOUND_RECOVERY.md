# Evidence-bound automatic receipt recovery (vNext candidate)

This change centralizes the **decision** for an existing crash-recovery flow.
It does not weaken the provider-dispatch journal, issue approvals, sign on a
user's behalf, or change relay acknowledgement semantics.

## Recovery behavior

| Durable proof | Action |
| --- | --- |
| Same exact action and approval authority, original never-dispatched PREPARED/one policy DEFERRED, Linux v3 same-boot same-PID-namespace provenance, and definitely exited owner | Candidate for automatic, atomic no-dispatch journal fence; complete negative receipt only after journal wins the dispatch lock. |
| Existing exact terminal INTERRUPTED journal fence with original first PREPARED transition and agent-kernel terminal marker | Repair original processing receipt as a **failed** no-dispatch result without invoking the provider; original approval authority must still match. |
| Mismatched action/approval authority, journal generation, missing owner provenance, old dispatch/observation, unknown process state, or copied host | Hold for review / independent provider proof. No automatic approval, no replay. |
| Original Windows FILETIME or portable PID evidence, even with a dead PID | Manual case-bound signed review until independent machine-provenance evidence exists. |
| Completed read receipt bound to a different authority (including original delivery 3443) | Remain blocked pending a separate read authority-safe reconciliation design. Never send the old result under a new authority. |

The policy is **pure**. Only `ActionTransitionJournal.interruptPreparedBeforeDispatch()`
commits under the same cross-process lock as provider `markDispatched()`. That lock
is necessary to prevent a race between recovery and real execution. The local
receipt can be marked terminal only after the journal fence is permanent.

The classifier is integrated into
`LocalActionExecutionStore.reconcileWithKernel()` and covered by deterministic
security cases for positive Linux evidence, wrong boot/namespace, Windows,
unknown/live owners, previously dispatched histories, terminal fences and
authority mismatches.

## Outstanding work before general availability

1. Independently security-review exact-source runtime and native helper provenance.
2. Add provider-native query/reconciliation adapters for side-effect-uncertain
   actions; require provider-issued identity and proof, never infer success from
   a request timeout.
3. Add hardware/OS-backed original-host provenance for Windows if automatic
   pre-dispatch recovery is desired there. **Do not use a Windows PID/filetime
   or user-DPAPI alone as a transferable original-host proof.**
4. Resolve cross-generation completed read conflicts with a no-disclosure
   transport protocol; never silently acknowledge delivery 3443.
5. Add separate physical-host failover acceptance, external signer/ledger
   review, restore-witness validation and release gating.

**Release status:** source-level candidate only. Do not apply this branch to
the existing original Windows device state until a reviewed runtime is
deployed and the exact incident is independently reconciled.
