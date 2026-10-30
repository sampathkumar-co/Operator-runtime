# Mecord Connect / MiniWoB: GitHub-only coding closeout
Date: 2026-10-30. PR #699; isolated benchmark integration and typed browser-provider source only.

## Source defects repaired in this phase
1. Model, transport, provider, budget and harness exception classes now have explicit noninterchangeable failure outcomes. Unexpected infrastructure conditions stop the campaign unscored. A bounded model decision error remains a task failure only after an independently measured BrowserGym reward.
2. Every completed Meta response must have valid, integer provider-reported token usage. Calculated usage is checked against the pre-call conservative reservation, and valid usage is persisted in a separate fsync-protected `mecord-provider-usage.jsonl` file. Reservations are not refunded. This is **not** a provider invoice, and no hard money-spend guarantee is possible without provider accounting.
3. `--task-id` uses its own index-zero one-task debugging plan; it is explicitly flagged `task_debug` and excluded from canonical campaign scoring. The pure task planner covers four-worker disjoint sharding.
4. Every JSONL task outcome carries a chained SHA-256 digest. The offline aggregator rejects modified, reordered or truncated chains, noncanonical task IDs, mixed runtime/native/vision/step conditions, and debug-only episodes. **SHA-256 chains are not signatures**: a malicious actor with write access could recalculate them. Independent release/host attestation remains mandatory.
5. Two successive verified observations may yield advisory movement facts for unique controls. The model is never granted unobserved coordinates; dispatch still requires fresh observed Mecord refs and browser-provider hit testing. This improves motion awareness but is **not** continuous moving-target pursuit.
6. Earlier fixes retained: cancellation-safe mouse release, native gesture gating against pinned package manifest, bounded graphical action grammar, fresh-reference pagination, and independent BrowserGym terminal/no-op scoring.

## Source quality gates
- The MiniWoB static test suite includes regression cases for typed error classification, provider-reported usage, budget-ledger audit trail, campaign-vs-debug planning, checkpoint chain checks and motion hints.
- C01 tests cover controller grounding, replay and source-only acceptance.
- C03 and the project-wide CI compile and test the native browser provider code.
- **Only exact final-HEAD CI is evidence**. Any later code or documentation commit supersedes earlier successful runs.

## Remaining physical/release gates (not source-code-fix claims)
- Build and inspect an exact-source, signed native-gesture-enabled Mecord runtime candidate on trusted infrastructure; independently verify content hashes beyond `runtime-manifest.json`.
- Confirm authorized device can run CDP Chrome gesture fixtures, SVG/canvas hit tests, dialog/OOPIF, held mouse cleanup after a simulated channel interruption and independent BrowserGym rewards.
- Verify Meta Contributor API schema, vision transport and actual invoices with authorized test spending. Workspace reserved cap $0.07 is insufficient for the specified 20/50-task image campaign under current conservative reservation.
- Run independent frozen 20, 50 and official 125-task campaigns, with real model calls and explicit failing/unscored cases. No 70% or task success claim without results.
- Continuous moving-target pursuit, exhaustive empty-canvas semantics and cross-host production TaskOrchestrator authority remain **unqualified**. No source-only CI certifies these behaviors.

## Decision
Keep PR #699 draft and release HOLD until exact-head CI plus signed runtime and physical/model/benchmark acceptance are complete. No npm publication, relay deployment, production TaskOrchestrator integration, secret export, paid Meta request or modification of the owner's offline laptop is authorized by this report.
