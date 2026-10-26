# Legacy open-PR security and integration triage — 26 October 2026

**Repository:** `sampathkumar-co/Operator-runtime`  
**Base inspected:** `main@932f3474b632ad5dc1ea7be63475e65ac0cf8b86`  
**Inventory:** 43 older open PRs, #14–#372. Newer PRs #610 and #611 have been merged separately.  
**Outcome:** **No legacy PR is authorized for blind merge.** Open does not mean malicious. Green historical CI does not certify merging old source over today's authorization, release or recovery paths.

## What this audit establishes

- Inventoried every one of the 43 PRs by target/base branch, diff filenames and security-sensitive change surface; inspected added code in the particularly sensitive production, release, authentication, replay and benchmark branches.
- Several PRs target other unmerged branches rather than `main`. This is an intentional *stack*. Merging every link individually and again via an integration PR would duplicate commits or reintroduce obsolete interfaces.
- Reconciled selected branch versions directly with `main`: current `src/core/resource-identity.ts` matches #328 exactly, while current durable read-race handling extends the #86 retry bound (~470ms vs ~315ms). Main has more evolved OTLP and browser-managed implementations than #82 and #310. Code already present must not be overwritten by stale patches.
- No claim of exhaustive malicious-code absence or full security certification. Diff sampling and filename/line auditing cannot prove a negative; third-party dependencies and dynamically invoked benchmark scripts remain separately untrusted.
- **Do not** run npm release workflows, activate an RC, contact production relay, install on the original host, publish credentials, or replay/ACK uncertain original-device receipts as part of PR cleanup.

## Per-PR dispositions

| PR | Source category | Disposition and specific blocker |
| --- | --- | --- |
| #372 | Control Center + relay convergence | **HOLD**: stacked on old RC3 integration preview, login sessions and recovery state cross authority boundary; must rebase and independently retest. |
| #371 | Original-host receipt disposition | **HOLD**: old RC3 integration base; never promote disposition reports to replay/ACK authorization. |
| #370 | Local browser login | **HOLD**: authentication/cookie/session and MCP dependency changes, 481 commits behind current `main` at audit; current session module is newer. |
| #368 | Production AI integration, 58 commits | **HOLD**: cumulative #360–367 source, modifies task execution/agent auth; historical PR explicitly says RELEASE HOLD. Source parity and approval review needed. |
| #367 | One-use model proposal | **STACK** on #366; reviewed-proposal behavior already separately hardened on `main`. Forward-port only missing proven behavior. |
| #366 | Model budget persistence | **STACK** on #365; ledger compatibility, crash recovery and durable spend accounting must be reconciled. |
| #365 | Model timeout and source audit | **STACK** on #364; changes production server and npm workflow coverage. |
| #364 | Grounded subgoal selection | **STACK** on #363; independent evidence and dispatch authority need exact-head certification. |
| #363 | Multi-step model task proposals | **STACK** on #362; task interpreter and quality-gate changes need current contract audit. |
| #362 | Local planning veto | **STACK** on #361; current orchestrator and uncertain-outcome semantics evolved. |
| #361 | Local model proposal intake | **STACK** on #360; changes authenticated agent server, MCP deps and model-origin scope. |
| #360 | Async planner decisions | **HOLD**: direct `main` PR is old; task orchestrator and Stop semantics have since changed substantially. |
| #359 | MiniWoB model benchmark controller | **EXTRACT**: original diff 109 files but comparison to current main leaves 16 `benchmarks/miniwob/` files. Runner reads a user-home credential file and can send requests to an external API; another script modifies an installed BrowserGym environment when invoked. Requires isolated credentials, no default external transmission, explicit test-only sandbox and fresh baseline. |
| #358 | Signed owner enrollment/replay ledger | **STACK/HIGH RISK**: depends on #357 and durable independent replay authority; original-device proof required. |
| #357 | WebAuthn owner step-up | **STACK/HIGH RISK**: depends on #356, signs owner recovery acts; must not treat agent bearer auth as owner signature. |
| #356 | Original-device recovery website | **STACK/HIGH RISK**: depends on #355; website must remain review-only until independent owner verification. |
| #355 | Evidence-bound recovery policy | **STACK/HIGH RISK**: depends on #354; automatic recovery decisions need signed/fenced source truth. |
| #354 | PREPARED destructive/no-replay adjudication | **HOLD/HIGH RISK**: old RC3 integration base; requires original-host signed independent review. |
| #353 | Authenticated relay recovery inspection | **HOLD**: useful metadata-only candidate, but nonmergeable old source; forward-port route and denial tests with source-pinned relay security review. |
| #352 | Relay gateway release verifier | **STACK** on RC3 integration; recertify published ingress path and no sensitive metadata exposure. |
| #342 | Integrated pipeline latency | **STACK** on old perf branch; modifies relay control and replay authority, not merely benchmark reporting. |
| #337 | Immutable 2.0.6-rc.3 | **ARCHIVE/RELEASE HOLD**: certification-only historical RC, must not merge into current runtime or publish. |
| #331 | Immutable 2.0.6-rc.2 | **ARCHIVE/RELEASE HOLD**: certification-only older RC; release identity/relay state must not regress. |
| #328 | Pathless Docker read recovery | **SUPERSEDED**: current `src/core/resource-identity.ts` has exactly the same file blob as old PR; remaining old relay changes require separate receipt-ownership audit. |
| #316 | Immutable 2.0.6-rc.1 | **ARCHIVE/RELEASE HOLD**: older source-pinned release candidate, not current branch source. |
| #310 | Dedicated headless Chromium | **EXTRACT/HOLD**: browser-owned profile and child-process boundaries have evolved; verify isolation, ports, executable, Stop and no external tab attachment. |
| #308 | Background tab latency experiments | **BENCHMARK ONLY/HOLD**: diagnostics and generated results on old perf branch; no physical replay and no implicit tab activation. |
| #306 | Pipeline instrumentation | **STACK/HOLD**: broad MCP/relay/local-agent changes from older perf branch, some already incorporated; forward-port only verified missing stages. |
| #111 | R4–R10 convergence | **HOLD**: 36 files including product/enterprise/control-plane and workflow; old full CI, R1 and Platform Matrix failed. Current versions exist. |
| #108 | R3 developer closeout | **STACK/HOLD**: workspace transactional edits and rollback may still be useful; must isolate from changed public tool surface and certify before port. |
| #107 | R3 change qualification | **STACK/HOLD**: old master-roadmap branch; reconcile with current qualification source and tests. |
| #99 | R3 session worktree | **STACK/HOLD**: developer-worktree capability absent from current main in same form; candidate for scoped forward-port, not wholesale merge. |
| #96 | R3 developer worktree operations | **STACK/HOLD**: same security boundary as #99; avoid duplicate public/developer authority additions. |
| #88 | R3 hermetic Git workspace | **STACK/HOLD**: exact-commit isolated workspaces need filesystem path, process and Git authority review. |
| #87 | R3 verified workspace edits | **STACK/HOLD**: original `verified-workspace-edit.ts` not present on main as that file; rollback/source-state verification requires source-matched reimplementation. |
| #86 | Durable read races | **SUPERSEDED**: main already implements bounded retry (~470ms), with stronger/current state logic than this historical ~315ms patch. |
| #82 | OTLP privacy trace | **SUPERSEDED**: main OTLP implementation is materially larger/newer; do not downgrade it with old export. |
| #74 | Node dependency lock remediation | **HOLD**: October 6 lockfile cannot establish current dependency security; regenerate from present dependency manifests and audit today. |
| #65 | R1–R2 coordination document | **STALE DOC**: no production code; describes unstarted work already represented by newer roadmap and tracker. |
| #61 | Stage 21–40 roadmap | **STALE DOC**: historical progress file predates current Wave 0–4 / 134-task tracker; do not overwrite canonical release truth. |
| #54 | Stage 21 external benchmark smoke | **BENCHMARK ONLY/HOLD**: historical frozen source baseline and external framework smoke, canceled matrix; rebuild against current harness instead. |
| #36 | Stage 2 compiled project goals | **STACK/HOLD**: old approval-card base; relay/task runtime and goal contracts since changed. |
| #14 | SPLCART Operator MS Store identity | **HOLD**: historical Windows Store MSIX identity and bootstrap/release workflow changes conflict with current Mecord product/source/version truth; needs explicit shipping identity decision. |

## Mandatory merge procedure

1. Compare each candidate against current `main`, not just its original PR base. Separate duplicated/superseded hunks, genuinely missing behavior and unrelated changes.
2. For any candidate not identical to current source, forward-port the smallest self-contained improvement onto *fresh* `main`, with explicit risk, operation boundaries and denial tests. Never mass-rebase full RC/recovery/planner stacks.
3. Audit dependency and workflow modifications, external network destinations, credential sources and exact allowlisted environment mutations. Remove benchmark credential-file assumptions before publishing test scripts.
4. Require exact-head passing CI, Windows/macOS/Linux Platform Matrix, R1, PR Evidence Contract and relevant source-specific gates before source merge. High-risk owner/replay/device changes require independent original-host physical certification **before** authority promotion, not just source CI.
5. After any accepted merge, update #374 and its C00–C11 issue with actual SHA and **source-only** status; preserve outstanding physical/RC acceptance gates. Close an obsolete legacy PR only after its required functionality is shown merged/superseded and a clear audit trail remains.

## Priority for safe extraction

1. Read-only authenticated relay recovery route (#353) after source-diff security review.
2. Missing scoped developer edit/worktree features (#87/#88/#96/#99/#108), Developer-only until certification.
3. Independent benchmark controller (#359), stripped of external credential-file and mutable installed-env assumptions, behind explicit isolated opt-in.
4. Production model planner #360–368 as narrowly staged, revocable and budgeted components only.
5. Recovery/web owner step-up #354–358 and old RC candidates only after original-host independent authority proof.

**No evidence found in this patch-level audit proves intentional poisoning. Equally, none of the 43 older PRs is currently certified for unconditional merge.**
