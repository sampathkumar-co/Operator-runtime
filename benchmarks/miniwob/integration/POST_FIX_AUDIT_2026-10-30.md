# Post-fix audit of Mecord Connect × MiniWoB graphical controller
Date: 2026-10-30. Scope: draft PR #699 stacked on #697 and browser-source repair #698.
Base revision: `614324a8e793b38b8110c52e92904a3859cf8476`.
Classification: source-level engineering audit, not runtime or benchmark certification.

## Result and evidence

The integrated source now contains the benchmark runner, frozen scorer, budget ledger, CDP bridge, candidate validator, source-pinned native gesture interfaces and browser provider. Source-level CI reported PASS at prior checked heads for:
- MiniWoB Integration Static Checks, including Python/Node grammar and synthetic controller/aggregation fixtures;
- C01 Isolated MiniWoB Controller Source;
- C03 Shipping Browser Independence;
- R2 source-specific runtime checks.
These are historical exact-head CI results; a later documentation commit must have its **own** checks. Core, platform, npm and Windows workflows must be assessed on the final exact head separately. They do not replace a live BrowserGym run.

No paid Meta call, new model-driven MiniWoB score, physical Windows browser gesture operation, original-device release signing or npm publication was performed during this repair. Remote Desktop Commander last reports owner device `LAPTOP-MRNU23B2` offline.

## Defects identified and fixed in this pass

| Severity | Finding | Repair | Regression |
|---|---|---|---|
| P0 | Held-button release helper requests cleanup without cancellation, but provider dispatch still passed the aborted action signal | `browser-cdp-frames.ts` now selects `undefined` signal on cleanup via `mouseSignalForDispatch`; applies to main and OOPIF sessions | `c03-browser-held-pointer-recovery.test.ts` tests signal selection after abort |
| P0 | Generic drag/resize and drag-between had their own mousePressed/mouseReleased path with no guaranteed release on mid-drag errors | Share `dispatchHeldPointerStroke` for all interpolated drags, preserving 4-20 bounded moves and pre-dispatch hit tests | Native and generic simulated drag cancellation |
| P0 | Double-click/Shift-click could leave a held mouse if a press or release RPC rejected | `dispatchNativeClickSequence` uses per-click finally release, with no automatic replay after failed press | Two clickCount releases and uncertain Shift-press regression |
| P1 | Modal-dialog observations omitted runtime capability flag and could falsely appear to switch native feature mode | Include exact `nativeGesturesEnabled` from pinned bridge runtime in modal observation envelope | Source contract audit, focused static checks |
| P0 | Scorer could accept reward=1 with no independent BrowserGym step or with a recorded execution error | Reject scored rows with zero steps, and reward-one rows containing errors; leave failures and unscored episodes distinct | Added canonical aggregate negative fixtures |

## Other previously repaired integration contracts preserved

- Source-identity reconciliation and exact compiled-runtime manifest digest on every episode.
- Scorer refuses mixed model, seed, task, harness, runtime, native feature flag, step limit or vision mode.
- No model-supplied CSS, arbitrary screen coordinates, stale ref, cross-frame drag or uncensored outcome replay.
- Native double-click, Shift-click and relative drawing limited to previously observed, generation-bound Mecord refs. Provider still hit-tests every drawing point.
- Source-bound observation paging. Every new page discards previous observed refs. Offset 640 and episode step limits remain.
- Real BrowserGym terminal/no-op reward for no-action episodes, with explicit unscored state on unavailable scoring.
- Vision minimum-reservation preflight fails before a paid run that cannot fit the existing USD 0.07 workspace cap.

## Audit of remaining failure modes

**Blocked, not solved by code alone**
1. No compiled signed new runtime installed with native gestures. Current pinned `mecord-connect@2.0.7-rc.6` cannot advertise them. Source on a GitHub branch does not change installed runtime behavior.
2. Owner laptop offline: cannot establish live Chrome CDP cancellation cleanup, canvas drag outcome, OOPIF interaction, screenshot pipeline or real MiniWoB independent reward.
3. No approved, measured Meta Contributor vision call on this integrated revision; API schema, actual token accounting and task success remain unverified.
4. The 20- and 50-task vision campaigns exceed conservative lifetime budget at a **minimum** of one 32,768-token-image reservation per task. Do not raise the spending cap without authorization.
5. No full official 125-task scorer evidence or frozen 50-task >=35 success certification. Do not report 70% success, or reuse earlier pilot percentages across changed harnesses.
6. Cursor-limited pagination and moving graphical targets still fall short of guaranteed exhaustive graphical coverage. No unrestricted coordinate clicking or autonomous screen scraping should be added to fake coverage.
7. Cleanup is best-effort if CDP transport is dead; state is uncertain and must not be blindly replayed.
8. Production TaskOrchestrator authority, approvals, historical receipts and signed owner release must be certified independently. Synthetic benchmark adapter must not be wired directly to personal browser tabs.

## Next acceptance sequence

A. Finish green exact-head CI, including Windows, platform matrix and npm-runtime build.
B. Independently produce and inspect a new compiled candidate's exact manifest, with source hash, signature and release provenance; install only through owner-authorized approval.
C. Credential-free browser smoke: native double-click, Shift-click, drawing, generic drag, cancellation/release, frame, dialog and pagination. Verify resulting DOM/canvas state and BrowserGym rewards.
D. Small authorized Meta multimodal pilot, with independently checked actual usage. Stop on provider/schema/usage uncertainty.
E. Frozen scored 20-task diagnostic, then valid 50-task qualification, then full 125-task campaign under an explicitly sufficient budget. Report unscored and failed cases separately.
F. Independent production authority and release review before merge/npm publication.

## Decision

**KEEP DRAFT / RELEASE HOLD.** Source repairs materially improve safety and auditability, but all physical, signed runtime and full benchmark outcomes are NOT_RUN. Do not claim every problem fixed, a working installed controller, or a MiniWoB score from source tests alone.
