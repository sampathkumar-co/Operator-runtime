# Wave 1 exact-source acceptance census

**Generated from the canonical 44-item tracker on 2026-10-25.** Scope: C02, C03, C04, C06 of [#374](https://github.com/sampathkumar-co/Operator-runtime/issues/374). This file inventories evidence surfaces; **file existence and a green CI run never prove a user-outcome acceptance test**.

## State and gating
- Source files/tests below exist in the repository at census time. They are representative evidence candidates, not per-checkbox certificates.
- Only **C03-12** has an explicitly accepted source-only tracker contract. The 43 remaining tracker checkboxes must stay open until their individual CI-integrated or physical acceptance criteria are proven.
- **Physical Windows acceptance: NOT_RUN** via this census. Chrome/Edge, UIA, Win32 native app, UAC/session security, device-specific DPI, true desktop focus, real service/DB and installer integration require separately pinned evidence.
- **Default npm runtime remains 2.0.6**, no artifact/owner installation or release claim is made.
- Source commit is mutable main across active PRs; obtain exact current SHA and run IDs from GitHub before any task status promotion.
- The rollout must not replay uncertain writes, reset persisted .operator state, broaden public nine-tool authority, rely on MiniWoB task-specific controller code, or invent benchmark pass rates.

## Per-task evidence and missing acceptance

| Task | Existing source | Representative test/workflow | Acceptance | Remaining evidence or capability |
|---|---|---|---|---|
| C02-01 | `src/core/capability-discovery.ts` | `test/c02-bounded-parallel-discovery.test.ts` | ACCEPTANCE OPEN | Host/session readiness and exact authority matrix |
| C02-02 | `src/core/provider-result-contract.ts` | `test/c02-provider-result-contract.test.ts` | ACCEPTANCE OPEN | Per-operation input/output and negative postcondition schema coverage |
| C02-03 | `src/core/rendered-evidence.ts` | `test/windows-uia.test.ts` | ACCEPTANCE OPEN | Cross-browser/desktop unified privacy, target and generation semantics |
| C02-04 | `src/capabilities/browser-cdp-page.ts` | `test/browser-target-spec-boundary.test.ts` | ACCEPTANCE OPEN | Common typed remedy taxonomy across providers |
| C02-05 | `src/core/router.ts` | `test/c02-provider-unsupported-action-deny.test.ts` | ACCEPTANCE OPEN | Semantic-first-to-visual fallback policy with verified modality decision |
| C02-06 | `src/capabilities/windows-uia.ts` | `test/c04-visual-capture-source-integrity.test.ts` | ACCEPTANCE OPEN | Cross-provider pre-dispatch generation and authority matrix |
| C02-07 | `src/capabilities/browser-cdp.ts` | `test/browser-cdp.test.ts` | ACCEPTANCE OPEN | Trustworthy deltas and focused pagination across all operations |
| C02-08 | `src/core/artifact-store.ts` | `test/c02-windows-visual-artifact-references.test.ts` | ACCEPTANCE OPEN | Sensitive screenshot retrieval through complete relay/API pipeline |
| C02-09 | `src/core/capability-conformance.ts` | `test/capability-conformance.test.ts` | ACCEPTANCE OPEN | Exhaustive built-in provider allow/deny/recovery/cancellation matrix |
| C02-10 | `apps/mcp-server/src/public-tools.ts` | `apps/mcp-server/test/public-mcp-closed-tool-contract.test.ts` | ACCEPTANCE OPEN | Version negotiation for private Developer contract plus MCP clients |
| C03-01 | `src/capabilities/browser-cdp.ts` | `test/browser-m1.test.ts` | ACCEPTANCE OPEN | Full independently measured Chrome/Edge operation matrix |
| C03-02 | `src/capabilities/browser-cdp-page.ts` | `test/browser-dom.test.ts` | ACCEPTANCE OPEN | Real-world control family corpus incl. SVG descendants |
| C03-03 | `src/capabilities/browser-cdp-frames.ts` | `test/browser-target-spec-boundary.test.ts` | ACCEPTANCE OPEN | Stale/ambiguous/invisible/obscured target proof on both engines |
| C03-04 | `src/capabilities/browser-cdp-frames.ts` | `test/browser-dom.test.ts` | ACCEPTANCE OPEN | OOPIF, cross-origin and closed-shadow limitation evaluation |
| C03-05 | `src/capabilities/browser-cdp-page.ts` | `test/browser-cdp.test.ts` | ACCEPTANCE OPEN | Virtualized list/nested scroll source-pinned fixtures and pagination |
| C03-06 | `src/capabilities/windows-uia.ts` | `test/c02-windows-visual-artifact-references.test.ts` | ACCEPTANCE OPEN | Browser semantic-insufficiency visual fallback and privacy end-to-end |
| C03-07 | `src/capabilities/browser-cdp-frames.ts` | `test/browser-m1.test.ts` | ACCEPTANCE OPEN | Real Chrome/Edge interaction family and download boundary certification |
| C03-08 | `src/capabilities/browser-managed.ts` | `test/browser-managed.test.ts` | ACCEPTANCE OPEN | SPA/dialog/auth/background-tabs multi-viewport regression matrix |
| C03-09 | `src/capabilities/browser-cdp.ts` | `test/c03-browser-recovery-causality.test.ts` | ACCEPTANCE OPEN | Independent goal-progress oracle and uncertain form-submission recovery |
| C03-10 | `src/capabilities/browser-cdp.ts` | `test/browser-cdp.test.ts` | ACCEPTANCE OPEN | Real Chrome/Edge across viewports/i18n/accessibility fixtures |
| C03-11 | `src/capabilities/browser-cdp.ts` | `test/c03-browser-genericity.test.ts` | ACCEPTANCE OPEN | Per-operation browser correctness, false-progress and p50/p95 |
| C03-12 | `scripts/c03-browser-genericity.mjs` | `test/c03-browser-genericity.test.ts` | SOURCE-GATE ACCEPTED | Accepted source-genericity gate; not functional benchmark proof |
| C04-01 | `src/capabilities/windows-uia.ts` | `test/windows-uia.test.ts` | ACCEPTANCE OPEN | Certified real OS/native-app availability and UIA matrix |
| C04-02 | `test/fixtures/windows-uia-contract-app/Program.cs` | `.github/workflows/c04-deterministic-uia-fixture.yml` | ACCEPTANCE OPEN | Interactive test-app UIA assertions beyond compile/describe |
| C04-03 | `native/windows-uia/src/uia.rs` | `test/windows-uia.test.ts` | ACCEPTANCE OPEN | Native process/tab/focus control identity integration |
| C04-04 | `native/windows-uia/src/visual.rs` | `test/windows-uia.test.ts` | ACCEPTANCE OPEN | Real keyboard/drag/clipboard/text/editor action matrix |
| C04-05 | `src/capabilities/windows-uia.ts` | `test/c04-visual-capture-source-integrity.test.ts` | ACCEPTANCE OPEN | DPI/multi-monitor/window movement physical evidence |
| C04-06 | `src/capabilities/windows-uia.ts` | `test/c02-windows-visual-artifact-references.test.ts` | ACCEPTANCE OPEN | Semantic-insufficiency fallback decision and safe scope |
| C04-07 | `src/capabilities/windows-uia.ts` | `test/windows-uia.test.ts` | ACCEPTANCE OPEN | Real pause/stop/cancel foreground change test |
| C04-08 | `native/windows-uia/src/main.rs` | `test/windows-uia.test.ts` | ACCEPTANCE OPEN | Native crash/heartbeat/restart/orphan certification |
| C04-09 | `native/windows-uia/src/protocol.rs` | `test/windows-uia.test.ts` | ACCEPTANCE OPEN | UAC/session/permission/secret-field negative matrix |
| C04-10 | `src/capabilities/windows-uia.ts` | `test/windows-uia.test.ts` | ACCEPTANCE OPEN | Installed Windows Chrome/Edge/native app measurement |
| C06-01 | `src/capabilities/filesystem.ts` | `test/filesystem.test.ts` | ACCEPTANCE OPEN | Full symlink/case/ADS/source-authority cross-platform tests |
| C06-02 | `src/core/multi-file-edit-plan.ts` | `test/multi-file-edit-plan.test.ts` | ACCEPTANCE OPEN | Crash-safe staged edits and owned rollback across concurrent files |
| C06-03 | `src/capabilities/git-write.ts` | `test/c06-git-write-exact-preflight.test.ts` | ACCEPTANCE OPEN | Branch/worktree/conflict-safe commit and no-data-loss oracle |
| C06-04 | `src/capabilities/project-command.ts` | `test/c06-mixed-developer-workflow-integration.test.ts` | ACCEPTANCE OPEN | Real allowlisted terminal/process completion and output artifacts |
| C06-05 | `src/core/developer-worktree.ts` | `test/developer-worktree.test.ts` | ACCEPTANCE OPEN | Node/Python test/build/lint incl. dependency and flaky failure classification |
| C06-06 | `src/capabilities/docker.ts` | `test/c06-docker-compose-identity-continuity.test.ts` | ACCEPTANCE OPEN | Real restricted Compose unrelated-service noninterference |
| C06-07 | `src/capabilities/postgres.ts` | `test/c06-postgres-typed-read-boundary.test.ts` | ACCEPTANCE OPEN | Real PostgreSQL profile/schema row/time/error smoke |
| C06-08 | `src/core/workspace-semantic-intelligence.ts` | `test/workspace-semantic-intelligence.test.ts` | ACCEPTANCE OPEN | VS Code + symbol/call semantic navigation physical evaluation |
| C06-09 | `src/core/evidence-pack.ts` | `test/developer-verification.test.ts` | ACCEPTANCE OPEN | External reviewer proof tied to source/build/test artifacts |
| C06-10 | `src/capabilities/project.ts` | `test/c06-mixed-developer-workflow-integration.test.ts` | ACCEPTANCE OPEN | Broader independent unfamiliar developer workflow campaign |
| C06-11 | `src/capabilities/process.ts` | `test/process.test.ts` | ACCEPTANCE OPEN | All nonbrowser provider cancellation, leak and side-effect matrix |
| C06-12 | `src/capabilities/git.ts` | `test/c02-exhaustive-provider-leaf-deny.test.ts` | ACCEPTANCE OPEN | Full unsupported-operation deny census without implicit shell/SQL |

## Exit procedure
Before changing a task checkbox to done: link the **exact merged commit**, approved production source diff, an **exact-head passing CI run**, negative safety and no-replay evidence, an independent real outcome oracle, and physical acceptance where the issue requires it. For tasks depending on laptop/OS state, do not conflate offline synthetic success with physical certification. Update #377, #378, #379 and #381 individually, then #374. Do not publish npm from source-only results.

**Census:** 44/44 source/test candidate rows found, 43/44 still acceptance-open. These fractions are inventory status, not an implementation percentage.
