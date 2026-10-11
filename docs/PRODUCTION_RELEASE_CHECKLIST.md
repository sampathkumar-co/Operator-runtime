# Mecord Connect — Production Release Checklist

**Last reviewed:** 2026-10-11 (Asia/Kolkata)  
**Release candidate:** [PR #295](https://github.com/sampathkumar-co/Operator-runtime/pull/295), branch `integration/p0-hardening-20261011`  
**Evidence head reviewed:** `01d2e5a1e1d6151afddf499b2eadf7e750e03fe6` (before this checklist commit)  
**Release decision:** **HOLD**. No production deployment, npm publication, or replacement of protected local runtimes until all required gates are checked against a single final source commit.

This is a *live execution tracker*, not a claim that any missing tests passed. Mark items `[x]` **only** after collecting reproducible evidence (commit SHA, exact command/run, machine, test outcome, time). Every subsequent project change should update this checklist and report the changed lines/checkmarks to the user. An already-green CI run on a predecessor commit is not certification of a newer head.

## A. Verified evidence from prior 2026-10-11 work

- [x] Source-level approval-path regression on Sampath Windows: 18/18 tests passed (`test/approval-path-parity.test.ts`, `approval-lifecycle.test.ts`, `session-approval.test.ts`); **not** live published-runtime parity.
- [x] Windows local performance suite passed 7/7 on source `9e697bf3`: local agent, policy, durable relay and soak; **not** model-to-laptop E2E.
- [x] Isolated real-Chrome CDP benchmark on Sampath Windows source `9e697bf3`: warm click p50 346.3ms/p95 362.3ms; 10-field form p50 3489.2ms/p95 3530ms; 30 and 10 samples respectively. Script `scripts/benchmark-browser-cdp-live.mjs`. **This is not Playwright visual testing or remote/MCP latency.**
- [x] Dedicated PostgreSQL 18 CAS generation/stale-writer CI on integration PR: [run 38111332452](https://github.com/sampathkumar-co/Operator-runtime/actions/runs/38111332452), passed.
- [x] Windows native Job Object synthetic local regressions: 3 iterations × 4 tests = 12/12 passed on Sampath Windows.
- [x] Dedicated Windows descendant-containment CI: [run 38111332437](https://github.com/sampathkumar-co/Operator-runtime/actions/runs/38111332437), passed.
- [x] Main CI, R1, R2, npm runtime CI and Windows signing *smoke* for `01d2e5a`: GitHub actions completed successfully. **Signing smoke is not a production certificate/signature.**
- [x] Historical relay delivery #2944 recovered without replay according to PR #295's original-machine operator attestation and canary receipts. Treat as *incident-specific recovery*, not a blanket recovery guarantee.

- [x] **Sampath hosted Mecord browser workflow (synthetic):** one real Chromium intake → catalog search → cart → checkout → independently verified server receipt on `LAPTOP-MRNU23B2`; **1/1 passed**, 12 verified MCP browser interactions; connector action p50 371 ms, p95 397 ms, observed call round trip p50 4,055 ms, p95 5,239 ms. This is not an autonomous task success-rate estimate. [Evidence](BROWSER_WORKFLOW_SAMPATH_2026-10-11.md).
- [x] **Sampath local full browser workflows:** **20/20** isolated real-Chrome/Playwright scenarios (server-backed independent state) passed, p50 491.74 ms/p95 558.16 ms. Trace, screenshot and report saved on laptop. This is local Playwright, not hosted Mecord or BrowserGym. [Evidence](BROWSER_WORKFLOW_SAMPATH_2026-10-11.md).

- [x] **#157 enterprise authority store single-machine cross-instance collision certification:** independent instances preserved 12/12 concurrently issued authority grants, fenced 12 parent revoke-vs-child-issue races and 12 emergency halt-vs-issue races with no active authority surviving. Reopen/restart checks passed 3 new tests + 2 existing typed authority tests on Sampath Windows. **The remaining durable-writer inventory and cross-host gate are not certified.**

## B. Highest-priority release security and reliability gates

- [ ] **P0 #251:** live same-account/device/session Chrome parity of direct `app.operate` and *fresh* `task_submit`, with no approval; then approved/same scope, cross-device, policy revocation, restarts, and task UUID replay. Save redacted real receipts. Synthetic 18/18 is insufficient.
- [ ] **P0 #146:** reservation-to-compensation durable handoff and genuine multi-process/host crash injection; demonstrate no duplicate reservation, no leaked authority, no blind replay.
- [ ] **P0 #192:** prove embedded + real PostgreSQL deletion/expiry/restore non-recycled generations on the final release head, including independent restore witness and stale clients. Dedicated PostgreSQL CI exists; actual restore/replay drills remain.
- [ ] **#151:** authority-backed operator resolution of quarantined team/mission identities, including unrelated identity, lost result, restart, and decision persistence.
- [ ] **#157:** complete remaining shared durable-writer lost-update/authority race audit; classify every listed store and add cross-process collision tests for confirmed gaps.
- [ ] **#279:** review newly green Windows contention and detached-descendant regression evidence, then independently certify under sustained concurrent load on final release head.
- [ ] **#293:** corroborate source-level pre-dispatch interruption and historical #2944 remediation with correct signed recovery proof and final-release artifact.
- [ ] Review code changes in #295 for downgrade/rollback/compaction and failure-path safety, with an independent security reviewer.
- [ ] Complete `npm run certify:nonbenchmark` on final candidate with the required native helpers and save the *terminal PASS* marker; a launched/partially logged run does not count.
- [ ] Final platform matrix (Ubuntu/Windows/macOS) must show completed success for **one single frozen final commit SHA**.

- [ ] **Browser-task success-rate release gate (#247):** require 30+ *hosted Mecord* fully graded browser tasks with representative held-out navigation/form/complex tasks and source-pinned p50/p95/p99 timings, not just the 1/1 hosted smoke or the 20/20 local Playwright suite. Do not substitute historical 83/83 unrelated E2E evidence. Compare to prior MiniWoB baseline and ensure direct/durable policy parity is tested separately.

## C. GKKTT227 physical laptop and visual Playwright audit

**Required target:** `LAPTOP-GKKTT227`, historical account `VENKATESH`, historical checkout `C:\Users\VENKATESH\OneDrive\Desktop\Mecordxn8n-Certification`. This checkout was previously used for Mecordxn8n certification; verify that it actually contains the intended *Operator-runtime* repository rather than assuming it does. User explicitly requested all laptop audits on this machine, not Sampath's deployment laptop.

- [x] **Headed Playwright harness prepared (not executed):** `scripts/audit-gkktt227-control-center-playwright.mjs` committed as `c4c6beb`. It requires hostname `LAPTOP-GKKTT227`, uses synthetic source UI with blocked network, collects 3 viewport × 13 tab screenshots, per-viewport trace/video, console errors, and overflow findings. **No pass claimed until actual machine run.**
- [ ] **Synthetic CI visual smoke:** Explicit GitHub Actions-only mode added to the existing Playwright fixture harness (`0643dba`), but the dedicated workflow creation was blocked, so no synthetic visual run/artifact exists. This separate smoke must NEVER substitute for headed GKKTT227 physical certification.
- [ ] **Connectivity:** targeted Remote Desktop Commander device must be online, and a read-only `hostname` + `whoami` confirms `LAPTOP-GKKTT227`. As of this review, the historical device2 connection is **offline**. Do not run tests on a different computer and claim GKKTT227 evidence.
- [ ] Identify correct authorized repository and preserve unrelated checkouts, running processes, app state and secrets; use isolated audit worktree/clone if necessary.
- [ ] Check clean checkout and pin exact PR/release SHA, Node/npm, browser and Windows versions; identify existing project Playwright configuration and local UI routes.
- [ ] Run real **headed/visible Playwright** in an isolated browser profile against an explicitly authorized **local** Control Center app/test fixture, without changing external accounts or submitting live forms.
- [ ] Capture Playwright trace, screenshots and video for navigation, login/session, onboarding, approval/recovery panels, tasks and browser/tab interactions **where implemented**, with browser console errors, request failures, and redaction of secrets.
- [ ] **ARIA keyboard navigation:** Tab/panel links, roving tabindex, arrow/Home/End handlers, static regression, and Playwright keyboard scenarios added (`5360162`). Still requires exact-head CI **and** real GKKTT227 Playwright screenshot/trace verification.
- [ ] **Responsive tab rail verification:** Source fix for 13-tab overflow (`f7cb724`), new static regression (`5f6900e`), and synchronized generated runtime template (`24f4c12`). CI had initially failed R4 generated-template parity before synchronization; confirm green R4/CI on the new head and obtain GKKTT227 Playwright screenshots before treating the visual defect as fully certified.
- [ ] Test desktop/tablet/mobile viewports, zoom, keyboard navigation, WCAG-oriented accessibility scans, component visibility/occlusion, layouts and focus/scroll stability. Distinguish unavailable screens from failing screens.
- [ ] Exercise synthetic negative/security paths: failed approvals, revoked access, stale identities, browser disconnect, rendering errors, and safe restart/recovery without side effects.
- [ ] Measure Playwright workflow p50/p95/p99 across 30+ warm/cold runs where feasible and compare to the isolated Chrome CDP baseline; record model/relay/host latency **separately**.
- [ ] Record a machine-linked visual audit report with exact code SHA, screenshots/trace locations, each failure, fix, rerun and pass/fail counts. Do not mark visual Playwright complete until artifacts exist.

## D. Distributed and deployment gates

- [ ] Two independently online physical machines: crash/restore/authority revocation/fencing and cross-host races (not just simulated unit tests).
- [ ] Restore-epoch witness drills, snapshot rollback protection, backup integrity, and mixed-version worker compatibility.
- [ ] Signed, provenance-verified Windows/npm successor artifact: build exact tree, notarize/sign as appropriate, verify install/uninstall/upgrade and package identity.
- [ ] Publish new npm release **only after** authorization and production gate approval, then independently install and verify published bytes. Existing installed 2.0.5 is older than the hardening branch.
- [ ] Stage canary -> verify remote MCP/relay/approvals/diagnostics -> progressive deployment, monitored rollback and post-release smoke.
- [ ] Record release owner and independent reviewer sign-off; update `docs/CURRENT_RELEASE_STATE.md` and machine-readable release truth **only after actual deployment**.

## E. Audit log / change history

| Date | Change | Verification | Checklist consequence |
| --- | --- | --- | --- |
| 2026-10-11 | Added `control-plane-live-postgres.yml` (commit `7cbfe58`) | GitHub CI real PostgreSQL PASS | A completed; B restore/physical gate remains open |
| 2026-10-11 | Added `windows-containment-stress.yml` (commit `d4edf04`) | GitHub Windows stress PASS; 12 local checks PASS | A completed; B sustained final-head sign-off remains open |
| 2026-10-11 | Added isolated Chrome benchmark script (commit `01d2e5a`) | Windows provider CDP benchmark completed | A completed; C Playwright audit remains open |
| 2026-10-11 | Rechecked device connections for `LAPTOP-GKKTT227` | Historical device2 target offline; no target-machine execution possible | C connectivity remains open |
| 2026-10-11 | Added machine-locked headed Playwright visual audit harness (commit `c4c6beb`) | GitHub source file committed, **not run** on GKKTT227; RDC connection still offline | C harness prepared; visual audit remains pending |
| 2026-10-11 | Fixed source-level Control Center horizontal tab clipping (`f7cb724`) and added regression (`5f6900e`) | Source reviewed; exact-head CI/Playwright not yet confirmed | Responsive tab gate remains unchecked; GKKTT227 still offline |
| 2026-10-11 | Rechecked previous checklist SHA `2500846` | All eight associated PR checks PASS (GitHub, including platform matrix) | Historic CI evidence updated; not final-head certification |
| 2026-10-11 | R4 audit found generated-template drift after CSS edit; synchronized `apps/local-agent/src/control-center.ts` from exact build inputs (`24f4c12`) | Verified determinism: reconstructed preceding build byte-identical to prior committed template; new CI queued | R4 parity regression fix submitted, **awaiting exact-head CI** |
| 2026-10-11 | Checked GKKTT227 again through RDC and three Mecord developer connectors | All target routes offline; no machine-specific Playwright execution possible | C connectivity/visual verification unchecked |
| 2026-10-11 | Confirmed source R4 product contracts at commit `b3d6db7` | [R4 CI 38112986845](https://github.com/sampathkumar-co/Operator-runtime/actions/runs/38112986845) SUCCESS; platform/signing predecessor runs cancelled by newer pushes | Generated-template fix supported; final-head full matrix still outstanding |
| 2026-10-11 | Added explicit CI-only synthetic Playwright mode (`0643dba`) | Source committed; dedicated GitHub workflow creation blocked; not executed | CI smoke separately pending; GKKTT227 still offline |
| 2026-10-11 | Prepared ARIA tab IDs/panels, keyboard handler, static test and regenerated UI runtime | GitHub code + CI on final head pending; GKKTT227 device2 registered account still offline | Keyboard gate open |
| 2026-10-11 | Added headed/CI synthetic Playwright keyboard interaction assertions (`5360162`) | Source committed, physical laptop has not run audit; connector account still returns OFFLINE | Keyboard and visual evidence pending |
| 2026-10-11 | Completed Sampath hosted real-Chromium Mecord workflow and 20 local browser-backed Playwright workflows | 1/1 hosted verified, 20/20 local; p50/p95 and screenshots/traces documented in `docs/BROWSER_WORKFLOW_SAMPATH_2026-10-11.md` | A evidence passed; #247 full hosted success benchmark remains open |
| 2026-10-11 | Cross-instance enterprise lease authority collision regressions (issue #157) | 12 issuance writers, 12 revoke/child races, 12 halt/issue races on Sampath Windows; 5/5 new + existing scoped tests passed | Enterprise authority-file narrow race checks passed; broader writer census remains open |
| 2026-10-11 | Created this persistent checklist on integration branch | File committed and branch verified | Release HOLD unchanged |

**Update rule:** after each code/document/test change, append a dated row, check off only independently evidenced steps, link the final artifact/CI run, and show the user the current checklist in the reply.
