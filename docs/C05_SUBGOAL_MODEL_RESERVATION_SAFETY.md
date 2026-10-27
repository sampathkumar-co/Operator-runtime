# C05 hardening: existing verified-subgoal scheduler

Source audit found the existing, more capable `src/core/local-model-subgoal-planner.ts` already on current `main`. The historical draft #364 is **not** a missing module and must not be bulk-merged or rewritten. This PR therefore only fixes current-main safety gaps, preserving the provider-neutral ranker, opaque dynamic checkpoint composer and deterministic fallback.

## Changes
- A fixed-loopback local model name is a bounded Ollama repository/name with optional tag, not a URL-shaped string. No endpoint selection is derived from model name.
- Both the existing READY-subgoal ranker and optional dynamic checkpoint composer require a fresh canonical Stop signal and **already-owned durable `reserveModelBudget`** callback.
- The same remaining-task or eight-second decision deadline and cancellation race begins **before** awaiting model-budget reservation, then wraps model inference. A hung or late reservation cannot launch a prompt after Stop/timeout.
- A monotonic elapsed-time check rejects reservation callbacks that finish after the decision budget, even if a runtime timer has not fired yet.
- Only previously verified, dependency-ready, scoped subgoals can be selected; existing runtime-owned checkpoint assertions and schema checks still determine what may run.
- No automatic Ollama scheduling or checkpoint composition is enabled by this source change.

## Verification and release
Synthetic tests check overlong model identifiers, missing Stop fence, late/hung reservations for READY selection and dynamic checkpoint composition, zero model calls after cancellation and unchanged durable plan. Source CI across Linux/macOS/Windows is the next gate. Physical original-device verification, real local-model latency, durable state restoration and npm release are **NOT_RUN**.