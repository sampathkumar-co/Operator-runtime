# MiniWoB × Mecord source integration: independent deep audit
**Date:** 2026-10-30. **Scope:** PR #699 stacked on #697/#695/#694, and copied generic native-browser code from #698/#696.
**Verdict:** Source-level integration implemented; owner-device physical integration, new compiled candidate and 20/50/125 model benchmarks **NOT VERIFIED**.
**Production policy:** Release HOLD. No npm publish, protected host mutations, real customer tabs, credential export or API spending is part of this patch.

## Evidence boundaries

1. Earlier scoped, credential-free Chrome/BrowserGym smoke passed for the pinned isolated 2.0.7-rc.6 benchmark in PR #695. That package does not contain the new native gestures.
2. PR #697 had successful focused CI, but its benchmark files were not merged to production.
3. PR #698 had successful browser source/npm/Windows checks, not physical native gesture acceptance. This PR copies the six browser source/test files from its reviewed head into a benchmark integration review branch; it is not a release.
4. Exact-head #699 source workflows are required. An earlier CI run is not evidence that a later source revision passes.
5. Historic older-code pilot was 2/7 with a separate transport error. No new independently comparable 20/50/125-run percentage exists.

## Layer-by-layer contract audit

| Layer | Source evidence | What is covered | Limitation |
|---|---|---|---|
| Authority boundary | `mecord_bridge.mjs` | Loopback bearer capability, one exact MiniWoB tab, fresh Mecord refs, no CSS/raw viewport coordinates from model | Owner's signed production authority not tested |
| Runtime pin | `runtime_pin.mjs` | RC6-only default; opt-in future candidate requires exact manifest bytes, version, source commit | New compiled signed package not yet built, host-supplied pin is not independent release signing |
| Graphical provider | `browser-cdp-frames.ts`, `browser-cdp.ts` | Explicit observed-ref double-click, Shift-click, 2-24 point held drawing and pre-dispatch hit-testing | No physical Chrome or canvas reward qualification |
| Pointer recovery | `browser-cdp-held-pointer.ts` | Finally attempts release even after canceled/uncertain native dispatch | Best effort only if CDP socket is unusable; post-dispatch uncertainty stays |
| Action parser | `mecord_observation.py` | Exact ref, role, replay, native capability, and decimal/point checks | Model chooses actions; quality unmeasured |
| Browser bridge | `bridge_actions.mjs`, `mecord_bridge.mjs` | Translation to bounded provider operations; validated relative drawing paths | Feature is disabled on compiled RC6 |
| Pagination | `inspection_paging.py`, bridge inspect | Model may request the provider-declared next offset without mixing stale refs | Cap at offset 640, task steps bounded; not infinite enumeration |
| Visual input | `browser_visual.mjs` | Synthetic tab CDP screenshot path with explicit opt-in | Meta vision transport/usage not verified against live API |
| Model | `run_live.py` | Structured Meta Contributor calls, bounded output/correction, per-call reservation | Actual inference may be slow, rejected or inaccurate |
| Budget | `budget_ledger.py` | Workspace-wide fsync reservations, fail-closed lock and infeasible vision campaign preflight | Ledger not provider invoice or global account-spend guarantee |
| Evidence | `run_live.py`, `outcome_scoring.py` | Independent BrowserGym reward, final no-action noop score, explicit unscored transport failure | End-to-end benchmark NOT_RUN on this revision |
| Aggregation | `aggregate_campaign.py` | Frozen task roster/seed, source/harness and compiled-runtime manifest digests, worker index, model/vision/step-limit agreement | Result files must exist from a completed authentic run |

## Additional issues discovered and repaired in this pass

- **P0: fragmented source**: benchmark PR #697 and native-browser PR #698 were not a single tested code tree. Combined without touching production runtime, with tests.
- **P0: runtime capability misrepresentation**: exact RC6 source must not advertise native gestures. New opt-in feature flag is honored only when exact nonlegacy compiled manifest digest and version/revision match.
- **P0: unsafe native model action path**: accepts only a currently observed element and bounded 2-24 two-decimal relative points; native provider still hit-tests individual points.
- **P0: mixed runtime scoring**: the scorer now requires an exact compiled runtime-manifest SHA-256 on every episode in addition to source/harness fingerprints.
- **P1: unsupported semantic pagination**: added provider-proven, bounded next-page inspection with no invented offsets or cross-page ref reuse.
- **P1: model action provenance**: native action schema is gated by an inspect response and a pure controller opt-in parameter; off by default.
- **P1: dangling reward 0 for no-action task**: authentic terminal BrowserGym noop scoring is attempted if no independent step occurred. Any inability to score is unscored, never a fabricated task failure.
- **P1: decimal validation**: corrected double-escaped regexes found in cross-language source audit and added regression cases.
- **P1: historical scorer API drift**: PR #697 reconciled frozen scorer and earlier worker fixtures, carried here.

## Security and quality concerns still open

- **Physical P0:** No new compiled signed source-pinned package and no device permission to run it. No new Chrome/BrowserGym/Meta reward evidence. Owner laptop offline.
- **Accuracy P0:** No fair baseline-vs-new identical 20/50/125 roster, seed, steps, model and cost comparison. The 70% gate is **NOT RUN**, not failed or passed.
- **Budget P0:** Full vision campaign under $0.07 reservation ceiling cannot fit even the 32,768 reserved image-input tokens per task. Never silently increase cap or skip tasks.
- **Vision P1:** Provider's structured multimodal API compatibility, screenshot image charge and actual Meta response behavior require an authorized live test.
- **Visual coverage P1:** Empty canvases, deeply nested frames, graphical object occlusion and continuously moving targets cannot be declared fully covered from source tests. Offset 640 and 10-step caps impose finite limits.
- **Pointer P1:** The mouse-release cleanup is best effort if the CDP socket dies during press; independent device reconciliation remains required.
- **Recovery P1:** No source test certifies protected historical receipts, release signing, cross-host task authority, or production TaskOrchestrator functionality from this isolated benchmark.
- **Provisioning P1:** Credentials must come from explicit approved host injection; do not route real model API keys through the browser bridge or commit them.

## Test acceptance matrix

1. Exact-head Python syntax; controller grounding, page offsets, terminal independent reward, scorer provenance and budget lock fixtures.
2. Exact-head Node syntax; model-visible ref/gesture checks, runtime manifest gating and CDP source independence.
3. Exact-head Core CI, npm runtime, Windows signing, platform matrix and PR evidence. Historical runs on earlier heads do not satisfy this.
4. A new isolated candidate with manifest pin and correct compiled BrowserCdpProvider; no unapproved release.
5. Credential-free, real Chrome provider probes: click/hover, horizontal/vertical scroll, drag/drop, dialog, nested frame, SVG/canvas, native double-click, Shift-click, held path and cancellation release.
6. One model vision pilot with verified actual Meta API compatibility and billing under separately authorized spend; no personal/browser data.
7. Fixed-roster 20-task diagnostic, then frozen 50-task (35+ authentic successes for 70% pass), then full official 125 tasks, reporting all failures/unscored episodes.
8. Independent review of production kernel authority and owner-device release evidence before any production merge/npm publication.

## Final decision
Keep this integration draft until all source checks and physical/model acceptance gates pass. Passing synthetic unit tests, manually sending a native browser event, or obtaining a zero-spend runner does **not** establish benchmark success. New remote execution permission is not supplied by a GitHub PR, and protected user-device actions must not be bypassed.
