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

## Additional independently instantiated writer collision tests

`test/priority-durable-writer-collisions.test.ts` adds three generic nonbenchmark cross-instance race probes: (1) 20 simultaneous world-model evidence sources survive with 20 distinct source claims, (2) 24 simultaneous optimizer receipts all commit once and 24 independent retries do not double-count, and (3) 12 independent enterprise-policy configurations retain 12 distinct, non-recycled durable generations. Alongside existing simultaneous enterprise SCIM upsert/revocation tests, **five focused tests passed**, zero failures, on Sampath Windows. `scripts/check.ts` also passed. They exercise separate in-process store objects sharing one state root; not separate physical machines.

## Subsequent exact-head OS-process writer certifications — October 12, 2026

- [#321](https://github.com/sampathkumar-co/Operator-runtime/pull/321) added a dedicated three-platform matrix that launches **four independent Node processes** sharing one reservation reconciliation ledger: 24 retry attempts on the same identity and four independent recovery intents, with foreign binding rejected and unrelated recovery records retained. Dedicated Windows/Linux/macOS CI passed, and PR was merged into P0 integration at `7b7f98ab5b504ef8783a4c92ddf848a7f98c6812`.
- [#324](https://github.com/sampathkumar-co/Operator-runtime/pull/324) added four real independent OS-process optimizer writers to exercise the cross-process `withDurableStateLock`: 24 distinct receipt-based successful writes followed by all 24 retried against a freshly reopened file, remaining exactly 24. Its five exact-head CI workflow families passed (including Windows/Linux/macOS) and it merged into P0 integration at `5270a45c60eae64426bef039b6bca99e6450c261`.
- These new tests extend the prior PR #304 cross-*instance* tests to separate operating-system processes with independent heaps. They still **do not** prove a shared-storage protocol on two independent machines, external monotonic restore fencing, mixed-version authority or the broader unclassified durable-store universe. **Issue #157 remains open** and release remains **HOLD**.
