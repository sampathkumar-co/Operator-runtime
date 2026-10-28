# Wave 1 coding branch: source truth (28 October 2026)

Scope: **C02/C03/C04/C06 only**. Base: merged Wave 0 `main@4ed95caa3c50707272deec8606caf9fb8094e9b7`.

This file records implemented work and precise residual uncertainty. It is **not** a claim that all Wave 1 requirements are complete or that any new npm RC or physical Windows acceptance has passed.

## Code implemented in this branch

- C02: Provider result and reconciliation receipts now require own-data records and bounded dense evidence arrays, rejecting executable accessors and sparse arrays before completion can be trusted. Regression test: `test/c02-inert-provider-receipt-contract.test.ts`.
- C02/C06: Resource extraction refuses sparse, accessor-backed or extra-key terminal `affectedResources` and `ports`, including overridden iterators; resource declaration is checked before dispatch. Regression test: `test/c02-c06-inert-terminal-resource-declarations.test.ts`.
- C06: Added explicit canonical `workspace.worktree.create` (write), `workspace.worktree.inspect` (read) and `workspace.worktree.release` (destructive) risks; canonical resource-extractor coverage and read-only/strictly conservative mutation-reconciliation policies.
- C06: Canonical resource extraction now binds worktree session identity and repository root, including physical fs identity overlap with Git; private and canonical scheduler keys are identical. Authorization sees the repository root, so allowed-root and exact risk policies apply before dispatch.
- C06: Developer Worktree provider now advertises typed capability schemas; local factory uses *explicit*, default-off `developerWorktree: { enabled: true, worktreeRoot }`, requires durable `stateDir` and registered roots, and does not widen the nine public MCP tools. Destructive release still requires a fresh approval.
- C06: Synthetic Git tests prove absent-provider denial, misrisk denial, out-of-root refusal, exact detached commit and clean worktree proof, inspect, destructive release approval, original repository preservation and conservative recovery.
- Updated canonical risk and resource-lease fixtures to account for the new exact-risk operations.

## Source tests on LAPTOP-MRNU23B2 (separate disposable worktree)

- Focused receipt/terminal/worktree tests: **15 passed, 0 failed, 1 POSIX-only skip**.
- Canonical risk and resource-lease tests: **58 passed, 0 failed**.
- C03 typed/browser source contract tests: **28 passed, 0 failed**.
- C04 Windows UIA source-contract tests: **24 passed, 0 failed**.
- The broader source run had process tests failing due absent packaged Windows Job Object/path-lease helpers, plus a process identity observation failure under the concurrent test run. Native process containment and real Windows app correctness **NOT_ACCEPTED**. Do not weaken or silently skip these physical gates.
- No new npm RC, real browser benchmark, deployed service, original-device state mutation, or physical release acceptance.

## Remaining Wave 1 coding / exit evidence to reconcile before one PR

- C02: Truthful provider readiness and generic conformance across all providers for cancellation, uncertainty, paginated artifact references and private/public schema negotiation.
- C03: Full browser DOM/CDP, cross-origin/OOPIF, shadow, virtualization, accessibility, upload/download, input and Chrome/Edge source coverage. Existing source tests do not certify the entire operation matrix.
- C04: Native Windows/UIA deterministic app fixtures, monitor/DPI/focus, sidecar restart and process descendant cleanup, cancellation, protected desktop/UAC rejection. Requires a compatible native helper at RC acceptance.
- C06: Verify end-to-end owned multi-file edit, exact Git/worktree transactions, trusted scoped test/build invocation, Docker and PostgreSQL, VS Code semantic navigation, artifact-based postconditions, and failed/uncertain side-effect recovery.
- The C02–C06 issue tracker checklists remain mostly unchecked. A source audit must reconcile existing implementations against these requirements before declaring coding 100%. No code or test acceptance is inferred from an unchecked item or a historical PR.
- Keep Wave 1 in ONE branch until source gaps are actually addressed. Open ONE Wave 1 PR only then. Do not publish npm or update production in this coding branch.

## 44-item source disposition after the 28 October audit

This is a source-coding census, not physical acceptance. `IMPLEMENTED` means the repository has a bounded implementation and source tests for the row's contract. `PARTIAL` identifies a concrete source or fixture limitation. Every `NOT_VERIFIED` entry remains open until the issue's independent physical campaign is run.

| Item | Source disposition | Residual acceptance / blocker |
| --- | --- | --- |
| C02-01 | IMPLEMENTED: bounded parallel capability discovery and exact readiness records | NOT_VERIFIED on installed host/session authority matrix |
| C02-02 | IMPLEMENTED: closed result, evidence, error, reconciliation and nested inert-JSON contracts; uncertain writes cannot be retryable | NOT_VERIFIED across every installed provider |
| C02-03 | IMPLEMENTED: normalized rendered evidence, privacy metadata, target and generation binding | NOT_VERIFIED across real browser and desktop captures |
| C02-04 | IMPLEMENTED: closed typed recovery-remedy taxonomy and target remedies | NOT_VERIFIED against real stale/ambiguous targets |
| C02-05 | IMPLEMENTED: router denies unsupported actions and fallback requires an explicit provider/modality decision | NOT_VERIFIED for real semantic-to-visual fallback outcomes |
| C02-06 | IMPLEMENTED: UIA generation, authority and visual-source integrity checks | NOT_VERIFIED against foreground changes on Windows |
| C02-07 | IMPLEMENTED: CDP deltas, bounded observations and continuation handling | NOT_VERIFIED across the full operation/browser matrix |
| C02-08 | IMPLEMENTED: artifact-store references and sensitive visual retrieval boundaries | NOT_VERIFIED through a deployed relay/API pipeline |
| C02-09 | PARTIAL: reusable conformance framework and negative provider tests exist; the built-in provider matrix is not exhaustive | NOT_VERIFIED; extend only from concrete provider gaps, not synthetic benchmark tasks |
| C02-10 | IMPLEMENTED: public nine stay closed; private Developer tools have explicit version/surface routing, including private worktrees | NOT_VERIFIED with MCP clients; local MCP SDK packages are absent |
| C03-01 | IMPLEMENTED: CDP lifecycle, operation dispatch and observation contracts | NOT_VERIFIED by independent Chrome/Edge measurement |
| C03-02 | IMPLEMENTED: DOM control-family targeting including descendant normalization | NOT_VERIFIED on a real-world SVG/control corpus |
| C03-03 | IMPLEMENTED: target identity, generation, ambiguity, visibility and obstruction checks | NOT_VERIFIED on both installed engines |
| C03-04 | IMPLEMENTED: frame traversal and open-shadow semantics with explicit inaccessible-boundary failures | NOT_VERIFIED for OOPIF/cross-origin/closed-shadow cases |
| C03-05 | IMPLEMENTED: bounded pagination, nested scrolling and virtualized-content re-observation | NOT_VERIFIED on installed browser fixtures |
| C03-06 | IMPLEMENTED: semantic-insufficiency can produce scoped visual evidence without widening authority | NOT_VERIFIED end to end on Windows |
| C03-07 | IMPLEMENTED: interaction families and download-boundary handling | NOT_VERIFIED on real Chrome/Edge downloads |
| C03-08 | IMPLEMENTED: managed tabs, focus, dialogs and bounded page state | NOT_VERIFIED across SPA/auth/background-tab viewports |
| C03-09 | IMPLEMENTED: cancellation/recovery causality; post-dispatch close, timeout or abort is non-retryable and uncertain | NOT_VERIFIED with an independent goal-progress oracle |
| C03-10 | IMPLEMENTED: browser operation and evidence contracts are viewport/i18n independent | NOT_VERIFIED on the required viewport/i18n/accessibility corpus |
| C03-11 | IMPLEMENTED: genericity and false-progress source tests | NOT_VERIFIED for physical correctness or p50/p95 |
| C03-12 | IMPLEMENTED: accepted source-genericity gate remains benchmark-task independent | Physical browser correctness remains outside this source gate |
| C04-01 | IMPLEMENTED: UIA provider schema, discovery and strict native protocol boundary | NOT_VERIFIED on installed Windows/native apps |
| C04-02 | PARTIAL: deterministic .NET contract-app source and CI compile/describe fixture exist; interactive UIA assertions are absent | NOT_VERIFIED; requires an interactive Windows runner |
| C04-03 | PARTIAL: native element/window identities and provider target binding exist; physical process/tab/focus identity integration is unproven | NOT_VERIFIED on Windows |
| C04-04 | IMPLEMENTED: native visual/input protocol families and source-native safety checks | NOT_VERIFIED for real keyboard/drag/clipboard/editor actions |
| C04-05 | IMPLEMENTED: visual capture carries source window, bounds, generation and integrity metadata | NOT_VERIFIED for DPI/multi-monitor/window movement |
| C04-06 | IMPLEMENTED: fallback is scoped, privacy-labelled and authority-bound | NOT_VERIFIED for real semantic insufficiency |
| C04-07 | IMPLEMENTED: abort/stop checks and foreground-generation rejection | NOT_VERIFIED with real foreground changes |
| C04-08 | IMPLEMENTED: sidecar framing, heartbeat, failure and restart boundaries | NOT_VERIFIED for native crash/orphan cleanup |
| C04-09 | IMPLEMENTED: closed native protocol and protected/secret-field rejection paths | NOT_VERIFIED for UAC/session/permission matrix |
| C04-10 | IMPLEMENTED: source contracts and deterministic fixtures cover installed-app capability declarations | NOT_VERIFIED on installed Chrome, Edge and native apps |
| C06-01 | IMPLEMENTED: scoped filesystem authority, canonical identity and symlink/reparse/ADS defenses | NOT_VERIFIED across the complete Windows/POSIX matrix |
| C06-02 | IMPLEMENTED: immutable multi-file plans, stale checks, staged replacement and owned rollback | NOT_VERIFIED under physical crash/concurrent-writer campaign |
| C06-03 | IMPLEMENTED: exact Git preflight, pathspec safety, checkpoints, uncertain-write recovery and private isolated worktrees | NOT_VERIFIED for the full branch/conflict/no-data-loss campaign |
| C06-04 | IMPLEMENTED: trusted project-command registry, bounded terminal/process execution and artifacts | NOT_VERIFIED with installed Node/Python toolchains |
| C06-05 | IMPLEMENTED: trusted worktree verification and structured test/build/lint outcomes | NOT_VERIFIED for dependency/flaky-failure corpus |
| C06-06 | IMPLEMENTED: restricted Compose identity and unrelated-service noninterference contracts | NOT_VERIFIED against a real Docker daemon |
| C06-07 | IMPLEMENTED: trusted local PostgreSQL profiles, typed reads, byte bounds and read-only sessions | NOT_VERIFIED against a real PostgreSQL instance |
| C06-08 | IMPLEMENTED: source/symbol/call semantic navigation and VS Code-oriented workspace intelligence | NOT_VERIFIED in installed VS Code/LSP environments |
| C06-09 | IMPLEMENTED: evidence packs bind source, commands, outputs and verification receipts | NOT_VERIFIED by an external reviewer |
| C06-10 | IMPLEMENTED: compound project workflows preserve authority, resources and postcondition truth | NOT_VERIFIED on the broader unfamiliar-workflow campaign |
| C06-11 | PARTIAL: provider cancellation and uncertain-side-effect contracts exist; packaged Windows path-lease/Job Object helpers are absent on this checkout's runner | NOT_VERIFIED for leak/descendant/process matrix |
| C06-12 | IMPLEMENTED: exhaustive leaf-deny tests prevent implicit shell/SQL or unsupported Git operations | NOT_VERIFIED against every optional installed provider |

Source conclusion: no additional significant Wave 1 source implementation gap was found outside the three explicit `PARTIAL` conformance/fixture/integration areas and the missing packaged Windows helper noted above. This does **not** close the 43 physical acceptance rows, certify performance, or justify a 100% Wave 1 claim.
