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
