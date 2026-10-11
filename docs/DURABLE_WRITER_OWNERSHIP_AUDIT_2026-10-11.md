# Durable writer ownership — targeted single-host audit

Date: 2026-10-11 (Asia/Kolkata)
Source baseline: `75dbc86a89e24be5db36c53818bdf2328e8b0fb8`
Device: original Sampath Windows `LAPTOP-MRNU23B2`
Scope: targeted issue [#157](https://github.com/sampathkumar-co/Operator-runtime/issues/157) evidence; **not** a completed repository-wide census and **not** cross-host certification.

## Concrete writer paths inspected

| Store | Shared mutation boundary | Verified evidence | Open question |
| --- | --- | --- | --- |
| `enterprise-authority-lease.ts` | Every `issue`, `revoke`, `emergencyHalt` and `clearEmergencyHalt` uses `withDurableStateLock` around load/mutate/commit, in addition to the per-instance serial queue. | New `test/enterprise-authority-cross-instance.test.ts`: 12 independent simultaneous issues all preserved; 12 revocation-vs-child-issue and 12 halt-vs-issue iterations; restart state has no unauthorized active leases. 4 new tests pass (including three genuine simultaneous OS-process writer instances). | A separate deployment's mixed-version workers and restore epoch cannot be certified on one host. |
| `account-device-registry.ts` | `#withQueue` obtains a process-bound exclusive `ResourceLeaseStore` lease spanning hooks and durable state mutation. | `test/account-device-registry.test.ts`: ownership/erasure/rebind/revocation scenarios; included in 34/34 focused tests. | Run multi-process crash/rebind faults for each external cleanup boundary. |
| `relay-result-store.ts` | Local `#mutate` wraps a `withDurableStateLock`; shared `#mutateShared` uses exact key/generation CAS and a typed shared epoch. | `test/relay-result-store.test.ts`, `relay-result-persisted-identity-types.test.ts` covered in 33/33 focused tests. | Cross-host provider CAS and historical backup restore require separate certification. |

Other #157 candidates with lock/CAS-like source references, **not fully classified** in this pass: `enterprise-identity.ts`, `intent-kernel.ts`, `enterprise-policy.ts`, `durable-saga.ts`, `relay-delivery-store.ts`, `event-runtime.ts`, `world-model.ts`, `procedure-memory.ts`, `execution-optimizer.ts`, `desired-state.ts`. A lexical occurrence of a lock is not proof that every effectful mutation holds that lock. Audit each reader/writer and its external authority transitions before marking #157 resolved.

## Actual Windows test commands and results

```
node --experimental-strip-types --test test/enterprise-authority-cross-instance.test.ts test/enterprise-lease-typed-authority.test.ts
# 6 pass, 0 fail, 0 skip

node --experimental-strip-types --test test/enterprise-authority-cross-instance.test.ts test/enterprise-lease-typed-authority.test.ts test/account-device-registry.test.ts test/relay-result-store.test.ts test/relay-result-persisted-identity-types.test.ts
# 34 pass, 0 fail, 0 skip
```

No production account or real external action was changed by these tests; all durable state roots were disposable temp directories.

## Release decision

These three store classes have targeted single-host evidence. **Issue #157 remains OPEN** pending the rest of the writer census, process crash/restart replay boundaries, genuine cross-host mixed-version authority and final published-artifact proof. Do not reinterpret passing tests as a release certification.
