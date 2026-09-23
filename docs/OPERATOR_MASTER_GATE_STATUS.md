# Operator Canonical Master Gate Status — G0–G36

Status date: 2026-09-23
Canonical plan: `OPERATOR_MASTER_REVERIFICATION_AND_RELEASE_PLAN.md`
Current production source: Mecord Connect `3b3b1bff35f8e78519f114b603f98e8acc56cd66`
Rollback baseline: OCC-3M `405be7a03270c6c7ced78cd0d0d58314048a1af7` / image `sha256:7f1114f7f78843db9bf1f8ea7d94baf1a9914bbe42f07d2fbea67db980aaec18`

This file maps the canonical G0–G36 master plan to the current evidence. It does **not** replace `OPERATOR_RELEASE_GATE.md`; that file is the compact 26-gate submission view. A gate is PASS only where current evidence supports the master-plan scope. External/owner steps remain BLOCKED rather than being inferred from local tests.

Current canonical count: **28 PASS / 9 BLOCKED / 0 NOT APPLICABLE**.

| Gate | Status | Current evidence / blocker |
|---|---|---|
| G0 Candidate Identity | PASS | Production is deployed from exact source `3b3b1bff35f8e78519f114b603f98e8acc56cd66`. The deployed Mecord Connect edge reports the v1 9-tool surface; OCC-3M remains only the rollback baseline. |
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
| G13 Authentication Correctness | BLOCKED | A real ChatGPT OAuth sign-in/reconnect completed against production and the refreshed connection reached the MCP edge. Remaining closure evidence is explicit revoke/disconnect failure plus reconnect recovery and sanitized token/audience proof. |
| G14 Authorization Correctness | BLOCKED | Static read/write-scope enforcement and negative token tests pass; real issued-token audience/resource and scope proof is still required. |
| G15 Device Identity | PASS | Device generation/enrollment/rebind/reset/disabled-account/quota paths and paired-device behavior are covered by certified tests. |
| G16 Relay Correctness | PASS | Relay WebSocket E2E is green; reconnect/session/ACK hardening is incorporated; relay/result/control ports are not publicly reachable. |
| G17 Isolation | PASS | User/device authority and multi-device isolation tests are green; public routing stays bound to authenticated principal/device authority. |
| G18 Secret Safety | PASS | DPAPI/native secret paths are green; public projection excludes credentials/tokens/private device material; focused evidence scans remain clean. |
| G19 Privacy & Minimization | PASS | Result projection/retention boundaries are documented/tested and live privacy terms disclose the hosted/local execution model. |
| G20 OpenAI Policy Alignment | PASS | Public capabilities are restricted to authorized developer-computer workflows; broader terminal/browser/UIA capabilities are intentionally not published. Final OpenAI review remains authoritative. |
| G21 Audit Integrity | PASS | Audit/path-authority security tests are green and hostile production probes produced no secret/error leakage. |
| G22 Recovery Correctness | PASS | Durable account/device cleanup, relay failure/recovery and production rollback paths are certified. |
| G23 Diagnostics Readiness | PASS | `mecord-connect` implements a bounded `doctor` command that verifies packaged file hashes/native helpers/UIA health and has regression coverage; clean-machine execution from the public registry is separately gated by G24. |
| G24 Clean-Machine Usability | BLOCKED | `mecord-connect@1.0.0` is public and a clean registry install plus installed `doctor` and `remote --help` pass. Final reviewer-root startup/pairing remains blocked because the paired local device was offline during the live ChatGPT check. |
| G25 Supply Chain Integrity | PASS | `mecord-connect@1.0.0` was published publicly under `latest` from source `3b3b1bff35f8e78519f114b603f98e8acc56cd66` after interactive npm authorization. Registry installation, installed `doctor`, `remote --help`, package/runtime file checks and vulnerability scan passed; 0 vulnerabilities were reported. |
| G26 Production Infrastructure | PASS | The final Mecord Connect edge from `3b3b1bff35f8e78519f114b603f98e8acc56cd66` is live. Production health, OAuth metadata, routing, 9-tool surface and hardened ingress/security boundaries were verified after deployment. |
| G27 Resource Safety | PASS | Performance regression and bounded hostile input probes are green; live edge remained healthy under the certified probes. |
| G28 CI Reliability | PASS | PR #28 exact head passed CI #911, Platform Matrix #681, NPM Remote Runtime #311 and Windows Signing Smoke #682; PR #29 passed CI #914, Platform Matrix #684 and Windows Signing Smoke #685; PR #30 exact head `c6589dd6437c4efcacf88059a219b82ae8585a73` passed every required check before merge. Revalidate the exact current `main` head before release. |
| G29 Public Truthfulness | BLOCKED | Production now serves the final Mecord Connect deployment and the public npm package is live with the selected publisher/license/dual-use metadata. Remaining blocker is OpenAI individual publisher verification and reconciliation if the verified legal-name spelling/order differs. |
| G30 Reviewer Usability | BLOCKED | A dedicated production reviewer account and reviewer-only one-factor authorization policy are provisioned and Authelia is healthy; normal users retain the two-factor default. The credential was not exposed to Git/chat. Owner retrieval/login verification, canonical fixture-only device pairing and the real end-to-end reviewer journey are still missing. |
| G31 Positive Reviewer Cases | PASS | All submitted five positive cases pass through the certified public boundary on the deterministic fixture; positive #5 is bounded `git.diff`. |
| G32 Negative Reviewer Cases | PASS | All submitted three negative cases pass, with additional `APPROVAL_REQUIRED` and duplicate-create safety assertions. |
| G33 Real ChatGPT E2E | BLOCKED | The real ChatGPT connection completed OAuth and refreshed to exactly 9 tools with no `device.claim`; live `computer.inspect` reached Mecord but returned `ROUTE_NO_DEVICE` because the paired local runtime was offline. Device-backed read/write plus revoke/reconnect proof remain. |
| G34 OpenAI Metadata Match | BLOCKED | A fresh ChatGPT conversation now exposes exactly the deployed 9-tool Mecord Connect surface and no `device.claim`. Final closure still requires the submission-portal **Scan Tools** result to be captured/reconciled against the same production SHA. |
| G35 Submission Readiness | BLOCKED | Final live Mecord Connect deployment and npm publication/clean-install proof are complete. Remaining blockers are OpenAI publisher verification, reviewer/device pairing, domain challenge if issued, Scan Tools, device-backed authenticated E2E, revoke/reconnect proof and the reviewer-accessible demo recording. |
| G36 Hostile Release Simulation | BLOCKED | A non-mutating OCC-3M pre-submission probe is recorded in `OPERATOR_HOSTILE_PRESUBMISSION_20260918.md` and is green for public pages, OAuth metadata/challenge fail-closed behavior, unauthenticated MCP, malicious Origin, forged Host and oversized JSON. Final G36 still requires the frozen final successor plus the real ChatGPT/reviewer/public-package path; release-blocking fixes would trigger affected recertification. |

## Blocking master gates

The nine currently blocked canonical gates are:

- **G13, G14** — real production OAuth/token/scopes evidence;
- **G24** — reviewer-root clean-machine startup/pairing completion;
- **G29** — final public software-license truthfulness;
- **G30** — real reviewer identity/pairing/journey;
- **G33, G34** — real ChatGPT E2E and OpenAI Scan Tools;
- **G35, G36** — final submission readiness and hostile frozen-candidate simulation.

## Cross-reference rule

Use `OPERATOR_RELEASE_GATE.md` for the compact submission verdict and this file for the canonical master-plan verdict. A PASS here must never be used to override a BLOCKED external/owner gate in the compact sheet. Any source/config/package change that changes the relevant candidate must update both views and rerun the affected evidence before release confirmation.
