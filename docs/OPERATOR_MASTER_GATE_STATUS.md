# Operator Canonical Master Gate Status — G0–G36

Status date: 2026-09-24
Canonical plan: `OPERATOR_MASTER_REVERIFICATION_AND_RELEASE_PLAN.md`
Current production source: Mecord Connect `a7fd8c960a82c9565b944ffb50535eeed6989c52`
Rollback baseline: OCC-3M `405be7a03270c6c7ced78cd0d0d58314048a1af7` / image `sha256:7f1114f7f78843db9bf1f8ea7d94baf1a9914bbe42f07d2fbea67db980aaec18`

This file maps the canonical G0–G36 master plan to the current evidence. It does **not** replace `OPERATOR_RELEASE_GATE.md`; that file is the compact 26-gate submission view. A gate is PASS only where current evidence supports the master-plan scope. External/owner steps remain BLOCKED rather than being inferred from local tests.

Current canonical count: **32 PASS / 5 BLOCKED / 0 NOT APPLICABLE**. Production/runtime release is complete; the remaining BLOCKED gates are OpenAI submission/reviewer evidence only.

| Gate | Status | Current evidence / blocker |
|---|---|---|
| G0 Candidate Identity | PASS | Production is deployed from exact source `a7fd8c960a82c9565b944ffb50535eeed6989c52`. The deployed Mecord Connect edge reports the v1 9-tool surface; OCC-3M remains only the rollback baseline. |
| G1 Architecture Truth | PASS | Hosted edge/auth/relay/local-runtime topology and the public-vs-internal capability boundary are documented and production-checked. |
| G2 Requirements Traceability | PASS | Current OpenAI auth/review/submission requirements are linked in certification evidence and were rechecked on 2026-09-18. Successive requirement rechecks directly found FG-016 (stable OAuth redirect), FG-017/FG-018 (publisher identity and notice reproducibility), and FG-019/FG-020 (required branding assets and required demo recording). |
| G3 MCP Truthfulness & Safety | PASS | Public surface is exactly 9 allowlisted tools; review-package annotations cover all 9; no raw terminal/browser/UIA tool is exposed. |
| G4 Filesystem Safety | PASS | Authorized-root, canonicalization/restricted-data and real Windows junction/path-authority coverage are green in the certified suite. |
| G5 Command Execution Safety | PASS | Command/process red-team coverage is green; raw terminal execution is intentionally absent from the public OpenAI surface. |
| G6 Git Safety & Integrity | PASS | Public Git is bounded to `git.status`/`git.diff`; Git/version/error paths are regression tested. |
| G7 Browser Safety | PASS | Browser capability remains internal and outside `PUBLIC_PLUGIN_TOOL_NAMES`; OCC-2 browser hardening is incorporated in OCC-3M and security regression remains green. |
| G8 UIA Safety & Determinism | PASS | Native Windows UIA sidecar builds/tests pass; UIA is not exposed through the public MCP surface. |
| G9 Adapter Safety | PASS | Certified core/platform suites cover integrated runtime adapters and the public allowlist prevents arbitrary adapter invocation. |
| G10 Policy Non-Bypassability | PASS | Cross-layer red-team/policy tests are green and local policy remains authoritative after remote dispatch. |
| G11 Approval Integrity | PASS | Approval binding, replay/expiry/recovery coverage is green; destructive `file.replace` still returns `APPROVAL_REQUIRED` without local approval. |
| G12 Prompt-Injection Resistance | PASS | Restricted paths/data and public-boundary adversarial tests fail closed; no public open-world browser capability exists. |
| G13 Authentication Correctness | PASS | Real ChatGPT OAuth sign-in/reconnect completed against production, refreshed the live 9-tool definition and reached the paired runtime. Earlier offline-device evidence is superseded by successful real device-backed requests. Additional reviewer/revoke capture is submission evidence, not a runtime-release blocker. |
| G14 Authorization Correctness | PASS | Public read/write scope enforcement is production-proven, and the separate Developer edge requires `operator:developer` plus explicit account entitlement; malformed/non-entitled Developer access fails closed. Portal-only token screenshots/capture remain optional submission evidence. |
| G15 Device Identity | PASS | Device generation/enrollment/rebind/reset/disabled-account/quota paths and paired-device behavior are covered by certified tests. |
| G16 Relay Correctness | PASS | Relay WebSocket E2E is green; reconnect/session/ACK hardening is incorporated; relay/result/control ports are not publicly reachable. |
| G17 Isolation | PASS | User/device authority and multi-device isolation tests are green; public routing stays bound to authenticated principal/device authority. |
| G18 Secret Safety | PASS | DPAPI/native secret paths are green; public projection excludes credentials/tokens/private device material; focused evidence scans remain clean. |
| G19 Privacy & Minimization | PASS | Result projection/retention boundaries are documented/tested and live privacy terms disclose the hosted/local execution model. |
| G20 OpenAI Policy Alignment | PASS | Public capabilities are restricted to authorized developer-computer workflows; broader terminal/browser/UIA capabilities are intentionally not published. Final OpenAI review remains authoritative. |
| G21 Audit Integrity | PASS | Audit/path-authority security tests are green and hostile production probes produced no secret/error leakage. |
| G22 Recovery Correctness | PASS | Durable account/device cleanup, relay failure/recovery and production rollback paths are certified. |
| G23 Diagnostics Readiness | PASS | `mecord-connect` implements a bounded `doctor` command that verifies packaged file hashes/native helpers/UIA health and has regression coverage; clean-machine execution from the public registry is separately gated by G24. |
| G24 Clean-Machine Usability | PASS | `mecord-connect@1.0.1` is public under `latest`; clean install, `doctor`, `remote --help`, one-command pairing/reconnect and the real paired-device path are proven. Reviewer-account simulation remains tracked separately under OpenAI submission gates. |
| G25 Supply Chain Integrity | PASS | `mecord-connect@1.0.1` was published publicly under `latest` from source `10914835e5ce4d8b1d2bf9952e8789efc8feb306` after interactive npm authorization. Registry installation, installed `doctor`, `remote --help`, package/runtime file checks and vulnerability scan passed; 0 vulnerabilities were reported. |
| G26 Production Infrastructure | PASS | The final Mecord Connect edge from `a7fd8c960a82c9565b944ffb50535eeed6989c52` is live. Production health, OAuth metadata, routing, exact 9/24 tool counts, Developer pairing-route isolation and hardened `git.diff` filtering were verified after deployment. |
| G27 Resource Safety | PASS | Performance regression and bounded hostile input probes are green; live edge remained healthy under the certified probes. |
| G28 CI Reliability | PASS | Historical release PRs passed their required suites, and production commit `a7fd8c960a82c9565b944ffb50535eeed6989c52` completed CI, Platform Matrix, NPM Remote Runtime CI and Windows Signing Smoke successfully before deployment. Future source successors must revalidate their own exact head before deployment. |
| G29 Public Truthfulness | BLOCKED | Production now serves the final Mecord Connect deployment and the public npm package is live with the selected publisher/license/dual-use metadata. Remaining blocker is OpenAI individual publisher verification and reconciliation if the verified legal-name spelling/order differs. |
| G30 Reviewer Usability | BLOCKED | A dedicated production reviewer account and reviewer-only one-factor authorization policy are provisioned and Authelia is healthy; normal users retain the two-factor default. The credential was not exposed to Git/chat. Owner retrieval/login verification, canonical fixture-only device pairing and the real end-to-end reviewer journey are still missing. |
| G31 Positive Reviewer Cases | PASS | All submitted five positive cases pass through the certified public boundary on the deterministic fixture; positive #5 is bounded `git.diff`. |
| G32 Negative Reviewer Cases | PASS | All submitted three negative cases pass, with additional `APPROVAL_REQUIRED` and duplicate-create safety assertions. |
| G33 Real ChatGPT E2E | PASS | The current 9-tool ChatGPT deployment passes real paired-device `computer.inspect`, `project.inspect`, file read/list/create, Git status/diff and read-back/SHA verification. Local approval/session continuation is implemented and release-certified. Reviewer-account and directory-submission exercises remain separate G30/G34/G35 work. |
| G34 OpenAI Metadata Match | BLOCKED | A fresh ChatGPT conversation now exposes exactly the deployed 9-tool Mecord Connect surface and no `device.claim`. Final closure still requires the submission-portal **Scan Tools** result to be captured/reconciled against the same production SHA. |
| G35 Submission Readiness | BLOCKED | Final live Mecord Connect deployment, npm publication, public 9-tool operation and Developer 24-tool hosting are complete. The blocker is OpenAI developer verification and the portal/reviewer steps that cannot proceed until that external gate is resolved. |
| G36 Hostile Release Simulation | BLOCKED | A non-mutating OCC-3M pre-submission probe is recorded in `OPERATOR_HOSTILE_PRESUBMISSION_20260918.md` and is green for public pages, OAuth metadata/challenge fail-closed behavior, unauthenticated MCP, malicious Origin, forged Host and oversized JSON. Final G36 still requires the frozen final successor plus the real ChatGPT/reviewer/public-package path; release-blocking fixes would trigger affected recertification. |

## Blocking master gates

The five currently blocked canonical gates are all OpenAI submission/reviewer-facing:

- **G29** — OpenAI individual/developer verification and exact verified publisher identity;
- **G30** — reviewer-account journey required only for directory review;
- **G34** — formal OpenAI portal Scan Tools capture;
- **G35** — app-directory submission readiness / Submit for Review;
- **G36** — final reviewer-facing hostile simulation on the submission candidate.

These do not block the already-complete npm/runtime/production release.

## Cross-reference rule

Use `OPERATOR_RELEASE_GATE.md` for the compact submission verdict and this file for the canonical master-plan verdict. A PASS here must never be used to override a BLOCKED external/owner gate in the compact sheet. Any source/config/package change that changes the relevant candidate must update both views and rerun the affected evidence before release confirmation.
