# Multi-step natural-language task proposal boundary — 2026-10-22

## Implementation
This draft increment builds on PR #362 and expands only the **local-model proposal validator**. The authenticated `POST /v1/tasks/propose` route remains non-executing and explicitly confirms `requiresConfirmation:true`.

Alongside one browser navigation or one registered project command, the model may now propose:

- `semantic-workflow` with **2-4** ordered atomic browser-navigation or registered test/lint/build project-command goals. Each action is independently scoped to caller-approved roots or origins; nested workflows, raw shell, arbitrary file writes and duplicate steps are rejected.
- `project-quality-gate` with **2-3 unique** `lint`, `test` or `build` checks, `requireAll:true`. A model is not allowed to weaken the gate to partial/best-effort success.

### Consent and authority
A model's output remains **a suggested contract, not permission**. The caller must inspect and explicitly submit the typed `goal` and `successConditions` to `POST /v1/tasks`. The existing TaskOrchestrator then applies canonical task scope, provider permissions, risk, authorization, user approvals, durable execution, reconciliation and independent verification.

This work does not let the model invent arbitrary browser interactions, choose unobserved tab identities, query unauthorized external domains, issue shell commands, install apps or modify files. Success-condition prose is not accepted as completion evidence.

### Validation
New unit tests exercise scoped multi-step acceptance; rejection of 5+ actions, repeated steps, cross-origin redirects in proposed URL targets, unauthorized project roots, destructive goals, and quality gates that permit partial success or unsupported commands.

**The Windows remote became unresponsive** during development; local tests from this branch were not run on the user's device. GitHub CI is needed before calling this branch verified. No model inference, installation, benchmark run, production relay restart, or live execution was attempted.

### Release blockers
This is still not the full general-purpose dynamic observe/decide/act planner. Unfamiliar desktop work, grounded screen navigation, official MiniWoB++, 25-task real-world acceptance, security threat modeling and the protected uncertain-relay recovery remain outstanding. Draft only; do not merge/publish/deploy.
