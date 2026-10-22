# Reviewed AI proposal confirmation — source boundary

## Purpose

Prior `POST /v1/tasks/propose` returned a non-executing AI suggestion. Clients then had to copy its goal into general-purpose `POST /v1/tasks`. That route still supports directly authorized task creation, but it did not prove the AI-generated goal had not changed between review and submission.

This additive flow offers a safer explicit review path:

1. Authenticated `POST /v1/tasks/propose` returns `proposal`, `proposalId`, `proposalDigest`, `expiresAt`, `requiresConfirmation:true`, and `executionStarted:false`.
2. The user inspects the exact proposed goal, allowed scope and success conditions.
3. Authenticated `POST /v1/tasks/proposals/confirm` accepts **only** `{ "proposalId": "...", "proposalDigest": "..." }`.
4. The server looks up the immutable proposal, binds it to the exact authenticated principal and enterprise grant context, re-evaluates permission scope against the stored goal, atomically burns the one-use review receipt, and calls canonical `TaskOrchestrator.submit`.
5. The response is a **pending task**, not execution approval or dispatch. Existing independent risk/permission checks, owner approval and `/v1/tasks/:id/run` remain required.

## Threat model and limitations

- No model can call confirm autonomously; clients must explicitly send a separate authenticated confirmation request.
- Never accept a replacement goal, an alternative scope, `run:true`, or approval authority on the confirmation request.
- Exact SHA-256 digest and unguessable UUID are bound to the submitted user objective, principal identity and scope; one-use receipts expire in two minutes.
- Registry is limited to 64 pending reviews per server and remains **ephemeral**. Restart invalidates pending review requests. No attempt is made to persist approvals to protected runtime state.
- A changed project permission invalidates the confirmation and requires fresh review.
- The existing direct `POST /v1/tasks` route remains available as an independently authorized workflow. This feature does not retroactively force every direct user task to originate from a model or claim to prove a human visually read the proposal.
- Scope recheck is not an execution grant: authorization is re-evaluated at actual dispatch.
- The pending task is still a durable record in the isolated task store; this route does not run a browser, issue a relay ACK, or certify original-host recovery.

## Verification

`node --experimental-strip-types --test test/task-proposal-review.test.ts test/task-goal-interpreter.test.ts`

Core, R1/R2, platform and Windows npm CI against the **exact head** must pass before merging. The private Windows laptop was offline, so no real device acceptance was run.

Full unknown-browser/desktop autonomy, production release, MiniWoB++ benchmark and original incident #351 remain separate blockers.
