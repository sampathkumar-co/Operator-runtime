# Mecord Connect — Production Capability Completion Roadmap
**Date:** 2026-10-24  
**Stable baseline:** `mecord-connect@2.0.6`, `main@b9682da964b8dfcda9b4ce65e1ba6352623bf7a5`  
**Tracker:** [#374](https://github.com/sampathkumar-co/Operator-runtime/issues/374)  
**Status:** Planning/documentation proposed. No production code changes or new certification claims are made by this document.

## Mission

Make Mecord a trustworthy, model-agnostic computer-execution substrate. A foundation model interprets user intent and chooses strategies; Mecord exposes truthful, bounded capabilities and observations, enforces canonical authorization, executes via the best supported provider, independently verifies *the requested outcome*, and recovers honestly.

The lost historical external GPT-OSS benchmark controller is **not** a Mecord feature, and no effort should optimize production for MiniWoB task IDs/selectors/hints. [PR #359](https://github.com/sampathkumar-co/Operator-runtime/pull/359) is an external evaluation adapter only. Another benchmark adapter could raise a leaderboard score without improving Mecord or a foundation model.

## Non-negotiable invariants

1. Never let the model, prompt injection, remembered procedure, model confidence or benchmark wrapper grant authority or override device/session policy.
2. Never retry a possibly applied write, external, destructive or consequential submission until authoritative reconciliation proves it is safe.
3. Preserve the original protected Windows `.operator` state, signed receipts and accepted historical UNKNOWN/INTERRUPTED records. No manual forged success, unsafe ACK, replay or deletion.
4. Every provider action uses canonical identity, risk, intent, scope, resource revision, lease and provenance checks.
5. VERIFY means an independently proven user-relevant postcondition, not the provider returning `ok: true`, a clicked control or model prose.
6. Preserve the public nine-tool MCP compatibility surface, with explicit separately governed Developer capabilities.
7. Work in small reviewable PRs, no force merges of historical stacked drafts, no source/provenance ambiguity and no uncontrolled paid model spend.

## Execution board: 12 workstreams, 134 atomic checkboxes

These issues are the **task source of truth**. Checkbox unchecked means *unassessed/not accepted*; code may already exist and needs review rather than rewriting.

| Workstream | Tracker | Tasks | Dependency | Laptop offline? |
|---|---|---:|---|---|
| C00 — Release/source truth and inventory | [#375](https://github.com/sampathkumar-co/Operator-runtime/issues/375) | 9 | None | GitHub CI |
| C01 — Three-lane independent evaluation | [#376](https://github.com/sampathkumar-co/Operator-runtime/issues/376) | 10 | C00 | CI yes, physical later |
| C02 — Typed universal capability/observation API | [#377](https://github.com/sampathkumar-co/Operator-runtime/issues/377) | 10 | C00 | CI yes |
| C03 — CDP/browser and visual grounding | [#378](https://github.com/sampathkumar-co/Operator-runtime/issues/378) | 12 | C01+C02 | CI yes, Chrome/Edge later |
| C04 — Windows UIA and physical desktop actions | [#379](https://github.com/sampathkumar-co/Operator-runtime/issues/379) | 10 | C01+C02 | CI yes, physical later |
| C05 — General workflow composition, optional AI | [#380](https://github.com/sampathkumar-co/Operator-runtime/issues/380) | 12 | C02 plus observations | CI yes, real model later |
| C06 — Developer/project/system providers | [#381](https://github.com/sampathkumar-co/Operator-runtime/issues/381) | 12 | C02+C05 | CI yes, physical later |
| C07 — Independent verification and memory | [#382](https://github.com/sampathkumar-co/Operator-runtime/issues/382) | 11 | C02–C06 | CI yes |
| C08 — Authority, durable writers, no-replay recovery | [#383](https://github.com/sampathkumar-co/Operator-runtime/issues/383) | 13 | C00+C02, parallel | CI yes, 2-host later |
| C09 — End-to-end latency/load/model cost | [#384](https://github.com/sampathkumar-co/Operator-runtime/issues/384) | 11 | C00–C02 | CI yes |
| C10 — Control Center/product/maintenance | [#385](https://github.com/sampathkumar-co/Operator-runtime/issues/385) | 11 | C00+C02 | CI yes, acceptance later |
| C11 — Candidate/canary/security/physical release | [#386](https://github.com/sampathkumar-co/Operator-runtime/issues/386) | 13 | All mandatory prior gates | Requires later access |

## Dependency-ordered execution plan

### Wave 0 — Freeze truth before changes
**C00** must establish exact source/package/helper release identity and enumerate existing capabilities and issue/PR status. **C01** freezes a model-neutral failure-attribution harness with three lanes. **C08** begins safe source and synthetic gap classification in parallel. C00/C01 can be prepared from GitHub while the laptop is offline.

**Exit:** each subsequent PR has a reproducible baseline, declared capability impact and objective-specific test cases.

### Wave 1 — Make providers reliable regardless of model
**C02** normalizes truthful action schemas, observed target generation/freshness, risk, error phase, provider availability and outcome evidence. **C03** deepens real browser semantics/visual fallback, and **C04** deeply tests Windows UIA/physical fallback. **C06** tests file/Git/terminal/project/Docker/Postgres/VS Code multi-tool workflows. Do not code around benchmark task names.

**Exit:** fixed model-independent action traces work through real provider execution; unsafe/unsupported actions fail predictably and without side effects.

### Wave 2 — General task composition and truth
**C05** only integrates optional generic model-provider assistance via safe, typed and bounded planning interfaces; deterministic planners remain first-class. It must not depend on an external MiniWoB driver and must not claim to improve model reasoning itself. Review reusable portions of [#368](https://github.com/sampathkumar-co/Operator-runtime/pull/368), specifically timeout/cancellation, durable token budget, reviewed one-use proposal and safe source integration, via smaller fresh-main PRs. **C07** independently checks that user success conditions are actually met.

**Exit:** representative unfamiliar nonbenchmark objectives are translated to allowed operations and verified after execution. Inconclusive outcomes remain inconclusive.

### Wave 3 — Reliability, speed and user trust
**C08** completes deterministic concurrent-writer, approval, relay and crash/reconnect certification. **C09** instruments the actual model-to-MCP-to-device-to-provider-to-proof pipeline before tuning. **C10** makes Control Center, onboarding, approval/recovery explanations and code structure understandable/maintainable. Review [#342](https://github.com/sampathkumar-co/Operator-runtime/pull/342) for performance, but do not assume old isolated A/B improvements apply to new main.

**Exit:** no relevant safety regression, source-supported rollback, measurable improvements in verified task efficiency and clear user-facing uncertainty.

### Wave 4 — Independent acceptance, source-pinned release
**C11** certifies exact reviewed candidate SHA: source/build/native provenance, clean installs, 9-tool contract, current CVE scan, unit/integration/security suites, realistic held-out tasks, physical Windows and authenticated relay/crash/recovery. Stage/canary opt-in read-only then reversible work then separately authorized external actions. Preserve unrelated VPS services and last-good rollback.

**Exit:** verified user-outcome improvement under matched conditions, zero certified authority violations/unsafe replays and no false VERIFIED in adversarial fixtures. Only after owner approval stage/publish npm with version chosen at release.

## Acceptance measurements: keep the components distinct

- **Lane A — model capability:** fixed observation and schema -> model decision. No Mecord runtime dispatch.
- **Lane B — Mecord execution fidelity:** identical scripted action sequence through Mecord vs expected application state. Model-independent.
- **Lane C — real integrated user completion:** same model, prompt, seed/task, action/time/token budgets and permissions with Mecord vs equivalent direct tools.

Record by model/version, task domain, SHA, seed: independently verified completion, failure stage, unauthorized effect, false completion, human intervention, p50/p95, tool/action rounds, elapsed time, cost and confidence interval. MiniWoB 125 is supplemental; not the entire product qualification. A held-out 50+ real-workflow set is the product gate.

**Proposed quality targets, not present results:** On the frozen supported-workflow suite aim for >=85% independently verified completion and >=95% on routine supported workflows, with zero unauthorized/unsafe replay and zero false VERIFIED in defined certification scenarios. Targets are negotiable with evidence; raw foundation-model limitations must not be misattributed to the Mecord runtime.

## Work protocol for implementation agents

1. Select lowest-dependency unchecked task; locate existing implementation and tests first.
2. Assign exact file ownership and intended API/contract delta. Parallel agents never modify the same worktree.
3. Reproduce the deficiency with independent fixture and capture before metrics.
4. Make the smallest general fix; **never** bypass authorization, proof or boundedness to raise a score.
5. Add negative, stale/ambiguous, authority, crash, concurrency, model-neutral and scope tests appropriate to the provider.
6. Run focused and full required suites; state exact observed pass/skip/fail and explain any skipped physical lane.
7. Review PR at exact HEAD SHA and merge in dependency order after real evidence.
8. Attach PR/commit/test links to checkbox issue, classify level of acceptance and mark complete only at the required level.
9. Re-baseline before next dependent task; no claims based on mocked tests alone.
10. Do not promise automatic unattended continuation if the user has disconnected the laptop; GitHub-source/CI work can proceed only when explicitly initiated.

## Release gate matrix

| Gate | Required proof |
|---|---|
| Source provenance | SHA, npm artifact and native-helper digests match reviewed merge |
| Contract correctness | Schema+capability conformance, risk and authorization correctness |
| Task success | Independent proof of requested goal across representative held-out domains |
| Security | Prompt injection/scope/approval failures denied; no secrets exposed |
| Recovery | No uncertain mutation replay, correct physical cross-host and restart evidence |
| Performance | Full pipeline before/after and bounded model spend |
| Product | Control Center, onboarding, stop/revocation and honest limitation UX |
| Deployment | Clean install, canary, unrelated container preservation and tested rollback |

### Disposition of existing work

- **Preserve:** released 2.0.6 security, journal, pairing, control plane, public nine-tool surface, procedural/world models and native providers.
- **Inspect and adapt:** draft #368 generic production interfaces, not wholesale merge.
- **Use only for evaluation:** draft #359 external MiniWoB controller.
- **Revalidate as performance candidate:** draft #342.
- **Track historical evidence:** existing #56, #151, #157, #192, #247, #251, #279, #293, #312, #351, #369 issues; an open issue is not by itself proof the original source defect remains.
- **Do not require:** lost historical controller or hardcoded benchmark rules.

## Completion reporting

For every workstream track 0: NOT ASSESSED, 1: SOURCE IMPLEMENTED, 2: CI VERIFIED, 3: MERGED/INTEGRATED, 4: PHYSICALLY/PRODUCTION VERIFIED, 5: RELEASE ACCEPTED. A checklist may represent work already coded but not yet accepted; do not convert it into an arbitrary overall percentage.

Any explicitly waived external gate is DEFERRED and disclosed, not certified PASS.

**End state:** not just hundreds of PRs, but a repeatably measured, trustworthy, versatile and useful real computer operator.
