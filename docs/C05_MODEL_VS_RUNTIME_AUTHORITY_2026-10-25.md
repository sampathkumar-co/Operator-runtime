# C05: Model reasoning is not Mecord execution authority

Status: **Source contract implemented in slices; product integration and real-model acceptance NOT COMPLETE**. Stable production remains `mecord-connect@2.0.6`. This document does not authorize any release or enable a model backend.

## Explicit separation

| Component | Responsibility | What it cannot do |
|---|---|---|
| External user or ChatGPT/model client | Form a requested objective and choose among suggested options | Grant device privileges, mint trusted observations, assert task success |
| `bounded-model-goal-inference.ts` | Accept owner-approved objective/scope for an injected model generator, require budget reservation, enforce output deadlines and type-check returned JSON | Execute a model automatically, enable network transport, authorize browser/OS changes, refund uncertain costs |
| `model-goal-proposal.ts` | Parse typed user-scoped navigation or trusted test/lint/build goals; reject forbidden capabilities and invented origins/targets | Determine current hardware identity, verify permissions, create execution rights |
| `task-proposal-review.ts` and `reviewed-model-goal.ts` | Bind a reviewed proposal to an exact principal/scope/digest and consume confirmation once | Bypass owner confirmation, persistent provider authorization, or issue action grants |
| `task-orchestrator.ts` | Run supported planners, enforce action budgets and coordinate observations, actions and outcome verification | Assume model text proves post-state or waive authority checks |
| `agent-kernel.ts`, policy, approvals, journals and resource leases | Check current authority, generation, execution phase and side-effect/recovery boundaries | Convert an old review, cached observation or model claim into new authority |
| `task-verifier.ts` and external evidence services | Correlate actual postconditions and bounded evidence with requested goal | Trust a success banner/model assertion instead of required independent proof |

The model reasons and *proposes*; Mecord validates input contracts, checks fresh scope/permissions, authorizes specific actions, executes through providers, verifies effects, and reconciles uncertain side effects. User-entered text and model output remain untrusted. None of these contracts can bypass Stop, require approval from browser-login cookies alone, or replay a protected receipt. Benchmark-specific external controllers and task-specific selectors must never become a shipping capability.

## Inference and approval flow (current source versus remaining work)

1. User explicitly approves sending a minimized objective and exact browser origins/project roots to the configured model provider. No default remote model endpoint is selected by the core source.
2. A **caller-supplied durable ledger** must reserve the call and maximum potential expense BEFORE invoking the provider. A timeout or invalid result is `UNKNOWN_SPEND`, not a proven no-charge.
3. The model returns only bounded typed JSON; unknown operations, custom shell commands, extra permissions, unapproved sites and roots are denied.
4. The independent review bridge issues a short-lived one-use receipt. A legitimate principal must confirm; fresh scope is checked again before generating task submission options.
5. The canonical task submission/kernel must authenticate principal, revalidate physical resources and generations, separately authorize every side effect, observe after changes and independently verify goals before returning VERIFIED.
6. STOP, account/device/session revocation, uncertain prior effects, cross-host restore and cancellation must fail closed.

**Currently implemented, not yet all connected:** Steps 1–4 exist as isolated typed libraries/tests. A production inference backend, durable model-call ledger, authenticated review API, independent real-model user-task evaluation, native source-matched Windows certification, hosted two-host recovery and full release gates remain open. Do not claim this design is a working AI controller or benchmark improvement.

## Acceptance proof boundaries

- PR #422: one-use review registry; exact-head CI and platform matrix passed.
- PR #423: scoped typed goal parsing; exact-head CI and platform matrix passed.
- PR #425: bridge without dispatch; exact-head CI and platform matrix passed.
- This PR: opt-in, provider-neutral injection and pre-call reservation boundary; at merge, require dedicated/latest-head CI and platform matrix, not prior-head checks.
- Canonical source roadmap: #374, workstream #380. C05-01 describes the boundary. C05-05 through C05-12 remain NOT_CERTIFIED for product operation until actual integrated model and user-task evidence exists.

Never place secrets, owner signing private keys, original receipt payloads or raw browser/account data in model prompts, evaluation fixtures, PR reports or logs.
