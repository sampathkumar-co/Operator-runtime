# P0 #157 — Durable writer census (17 priority stores)

**Date:** 2026-10-11. **Base:** `9242c98609eedd82897b06e7c7e1d5e1577f1325`. **Scope:** single original Sampath Windows machine plus CI; NOT production or two-machine certification.

Instance-local `#serial` / `#queue` never supplies cross-process ownership by itself. The relevant shared mutation entry point must hold a process-instance-aware lease, file lock with fresh reread, or transactional CAS.

| Store in src/core | Shared mutation entry / authority design | Evidence or unresolved boundary |
| --- | --- | --- |
| account-device-registry.ts | #mutate → #withQueue → ResourceLeaseStore exact process-bound owner, including async cleanup | account authority and independent registry process tests |
| enterprise-authority-lease.ts | issue/revoke/halt under withDurableStateLock | PR #298: 12 concurrent grants, 12 revocation/child races, 12 halt/issue races, 3 actual OS writers × 4 |
| enterprise-identity.ts | updates under withDurableStateLock | enterprise identity integrity/type tests |
| intent-kernel.ts | update under withDurableStateLock | intent-cross-instance, generation integrity tests |
| enterprise-policy.ts | mutation under withDurableStateLock | enterprise-policy and exact type tests |
| action-transition-journal.ts | #mutate under withDurableStateLock, terminal fence under journal authority | signed pre-dispatch and provider-dispatch race tests |
| control-plane-store.ts | embedded file lock; PostgreSQL transactional CAS and durable tombstones | ABA delete/recreate/expiry/restart tests; actual PG18 witness/CAS PR #302 |
| durable-saga.ts | #mutate lock plus per-saga execution owner | cross-instance and crash owner tests |
| relay-delivery-store.ts | local #mutate lock; shared store provider CAS | delivery convergence and persisted identity |
| relay-reservation-reconciliation.ts | #mutate under withDurableStateLock | reservation provenance and unknown-outcome tests |
| relay-result-store.ts | local #mutate lock; shared provider CAS | result store identity/CAS regression |
| desired-state.ts | process-bound ResourceLeaseStore over effectful reconciliation | desired-state cross-process and uncertain remedial tests |
| digital-operations.ts | #withOperationOwnership spans external effects and nested #update | genuine child SIGKILL after allocation before confirmation, PR #297 |
| event-runtime.ts | #mutate under withDurableStateLock | event-provider and cross-process event writer tests |
| world-model.ts | observe under withDurableStateLock | world history/identity tests |
| procedure-memory.ts | verified record/outcome changes under withDurableStateLock | memory/outcome tests |
| execution-optimizer.ts | strategy/outcome changes under withDurableStateLock | optimizer replay/idempotency tests |

## Executed on exact merged source

- **26 priority writer test files:** 178 total, **174 pass, zero fail, four platform/fixture skips**.
- **Seven high-risk recovery test files:** 109 total, **108 pass, zero fail, one skip**, including #146 reservation hard kill, #192 nonrecycled CAS tombstone generations and #293 signed pre-dispatch fencing.
- **Windows process containment #279:** 3 different detached-descendant and recursively detached grandchild tests × 5 consecutive rounds = **15 pass, zero fail**; native helper independently built and self-tested.
- **PR #302 on actual PostgreSQL 18 CI service:** 11/11 witness, quarantine CAS, authority and process crash tests; a disposable database, **not production WAL restore**.

This is **source-entry-path evidence** rather than proof that every indirect caller or future writer uses a lock. Production independent provider signer, external trust-domain restore witness, mixed-version deployed clients, unrelated out-of-scope durable stores and the actual public package still need separate evidence. Owner-deferred two-machine certification is explicitly not claimed. **Do not close #157's wider production acceptance from this report alone.**
