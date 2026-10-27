# C05 advisory-specific durable budget and Stop lifetime

This source-only integration gives an **already explicitly configured** `TaskPlanningInfluenceProvider` its own pre-dispatch advisory authority window after `TaskPlanner.next/repair` finishes. It does **not** configure Ollama or enable advisory behavior by default.

## Why this is separate

The planner's `reserveModelBudget` callback is intentionally revoked as soon as `next/repair` settles. An advisory which reuses that callback would be unable to reserve legitimately, or worse, might tempt a weakened revocation policy.

Instead, `makeBudgetReservation(signal)` produces independently signal-bound closures sharing the *same serialized durable reservation queue and failure state*. The existing planner keeps its own short-lived closure. After typed policy/risk preflight and exact proposal digest, the advisory phase creates a new controller and Stop/Pause signal, calls the exact same durable reserve-before-transmit function, and revokes the callback in `finally`.

- Calls to either closure after its signal was aborted fail closed.
- A late advisory response after Stop, Pause or the remaining task deadline cannot dispatch the suggested action; `boundedPlannerCall` races cancellation.
- Reservations are charged/persisted before model inference; timeout, cancellation or ambiguous provider spend do not automatically refund them.
- Provider model advice still cannot grant tools, mutate goals, change kernel policies, claim verification, replay uncertain writes or bypass final permission checks.
- The startup does not auto-register the new local advisory. Model selection and trusted owner configuration remain separate, not hidden in this change.

New regression tests run the real `TaskOrchestrator` with a synthetic advisory over disposable file/Git state: one source-level advisor charge survives reload; a captured callback is unusable after its phase. Another test uses a deliberately uncooperative advisory and checks Pause returns without dispatch, revokes the signal, and keeps the target file absent.

**Not certified:** physical Windows Stop/race verification, actual Ollama, long-run stress, hosted relay, original-device receipts, signed package and release acceptance.