# Operator Canonical Master Gate Status — G0–G36

Status date: 2026-09-18
Canonical plan: `OPERATOR_MASTER_REVERIFICATION_AND_RELEASE_PLAN.md`
Certified production baseline: OCC-3M `405be7a03270c6c7ced78cd0d0d58314048a1af7`
Production image: `sha256:7f1114f7f78843db9bf1f8ea7d94baf1a9914bbe42f07d2fbea67db980aaec18`

This file maps the canonical G0–G36 master plan to the current evidence. It does **not** replace `OPERATOR_RELEASE_GATE.md`; that file is the compact 26-gate submission view. A gate is PASS only where current evidence supports the master-plan scope. External/owner steps remain BLOCKED rather than being inferred from local tests.

Current canonical count: **27 PASS / 10 BLOCKED / 0 NOT APPLICABLE**.

| Gate | Status | Current evidence / blocker |
|---|---|---|
| G0 Candidate Identity | PASS | Production/main remain exact OCC-3M; live edge tag and image digest match the frozen candidate. |
| G1 Architecture Truth | PASS | Hosted edge/auth/relay/local-runtime topology and the public-vs-internal capability boundary are documented and production-checked. |
| G2 Requirements Traceability | PASS | Current OpenAI auth/review/submission requirements are linked in certification evidence and were rechecked on 2026-09-18. Successive requirement rechecks directly found FG-016 (stable OAuth redirect), FG-017/FG-018 (publisher identity and notice reproducibility), and FG-019/FG-020 (required branding assets and required demo recording). |
| G3 MCP Truthfulness & Safety | PASS | Public surface is exactly 10 allowlisted tools; review-package annotations cover all 10; no raw terminal/browser/UIA tool is exposed. |
| G4 Filesystem Safety | PASS | Authorized-root, canonicalization/restricted-data and real Windows junction/path-authority coverage are green in the certified suite. |
| G5 Command Execution Safety | PASS | Command/process red-team coverage is green; raw terminal execution is intentionally absent from the public OpenAI surface. |
| G6 Git Safety & Integrity | PASS | Public Git is bounded to `git.status`/`git.diff`; Git/version/error paths are regression tested. |
| G7 Browser Safety | PASS | Browser capability remains internal and outside `PUBLIC_PLUGIN_TOOL_NAMES`; OCC-2 browser hardening is incorporated in OCC-3M and security regression remains green. |
| G8 UIA Safety & Determinism | PASS | Native Windows UIA sidecar builds/tests pass; UIA is not exposed through the public MCP surface. |
| G9 Adapter Safety | PASS | Certified core/platform suites cover integrated runtime adapters and the public allowlist prevents arbitrary adapter invocation. |
| G10 Policy Non-Bypassability | PASS | Cross-layer red-team/policy tests are green and local policy remains authoritative after remote dispatch. |
| G11 Approval Integrity | PASS | Approval binding, replay/expiry/recovery coverage is green; destructive `file.replace` still returns `APPROVAL_REQUIRED` without local approval. |
| G12 Prompt-Injection Resistance | PASS | Restricted paths/data and public-boundary adversarial tests fail closed; no public open-world browser capability exists. |
| G13 Authentication Correctness | BLOCKED | Static/provider checks, S256, resource binding and both OpenAI redirect forms now pass preflight; one real human authorization/code exchange, revoke/reconnect proof and production MCP success are still required. |
| G14 Authorization Correctness | BLOCKED | Static read/write-scope enforcement and negative token tests pass; real issued-token audience/resource and scope proof is still required. |
| G15 Device Identity | PASS | Device generation/enrollment/rebind/reset/disabled-account/quota paths and paired-device behavior are covered by certified tests. |
| G16 Relay Correctness | PASS | Relay WebSocket E2E is green; reconnect/session/ACK hardening is incorporated; relay/result/control ports are not publicly reachable. |
| G17 Isolation | PASS | User/device authority and multi-device isolation tests are green; public routing stays bound to authenticated principal/device authority. |
| G18 Secret Safety | PASS | DPAPI/native secret paths are green; public projection excludes credentials/tokens/private device material; focused evidence scans remain clean. |
| G19 Privacy & Minimization | PASS | Result projection/retention boundaries are documented/tested and live privacy terms disclose the hosted/local execution model. |
| G20 OpenAI Policy Alignment | PASS | Public capabilities are restricted to authorized developer-computer workflows; broader terminal/browser/UIA capabilities are intentionally not published. Final OpenAI review remains authoritative. |
| G21 Audit Integrity | PASS | Audit/path-authority security tests are green and hostile production probes produced no secret/error leakage. |
| G22 Recovery Correctness | PASS | Durable account/device cleanup, relay failure/recovery and production rollback paths are certified. |
| G23 Diagnostics Readiness | PASS | `@mecrod/operator` implements a bounded `doctor` command that verifies packaged file hashes/native helpers/UIA health and has regression coverage; clean-machine execution is separately gated by G24. |
| G24 Clean-Machine Usability | BLOCKED | The intended public package does not yet exist on npm; final fresh-machine `doctor` and reviewer-root startup cannot be certified until the exact first tarball is published. |
| G25 Supply Chain Integrity | BLOCKED | OCC-3N publication machinery is green, but the final package is still blocked on owner-approved license, npm dual-use classification, scope ownership/2FA, exact first-tarball publication and post-publish verification. |
| G26 Production Infrastructure | PASS | TLS/SNI/Host/origin/body/header/port hardening is live; production edge remains exact OCC-3M and healthy. |
| G27 Resource Safety | PASS | Performance regression and bounded hostile input probes are green; live edge remained healthy under the certified probes. |
| G28 CI Reliability | PASS | OCC-3M exact-source CI/platform/npm-runtime/signing runs and the 361-test Windows-aware suite are green; race-sensitive relay fixes were re-regressed. |
| G29 Public Truthfulness | BLOCKED | Hosted Operator privacy/terms/support pages are live, but public npm distribution still has no effective software license and the exact legal publisher identity is not yet named consistently across Operator/SPLCART legal materials. FG-013 and FG-017 must be resolved before public legal/package claims can be finalized. |
| G30 Reviewer Usability | BLOCKED | A dedicated production reviewer account and reviewer-only one-factor authorization policy are provisioned and Authelia is healthy; normal users retain the two-factor default. The credential was not exposed to Git/chat. Owner retrieval/login verification, canonical fixture-only device pairing and the real end-to-end reviewer journey are still missing. |
| G31 Positive Reviewer Cases | PASS | All submitted five positive cases pass through the certified public boundary on the deterministic fixture; positive #5 is bounded `git.diff`. |
| G32 Negative Reviewer Cases | PASS | All submitted three negative cases pass, with additional `APPROVAL_REQUIRED` and duplicate-create safety assertions. |
| G33 Real ChatGPT E2E | BLOCKED | Requires the actual OpenAI draft/connection, completed OAuth login, relay/device execution, read/write results, revocation and reconnect. |
| G34 OpenAI Metadata Match | BLOCKED | OpenAI Scan Tools has not yet imported/reconciled the exact production 10-tool surface. |
| G35 Submission Readiness | BLOCKED | Exact publisher legal-identity reconciliation/verification, reviewer credentials, npm release, final branding composition, domain challenge if issued, Scan Tools, authenticated E2E and the required reviewer-accessible demo recording URL are still incomplete. |
| G36 Hostile Release Simulation | BLOCKED | A non-mutating OCC-3M pre-submission probe is recorded in `OPERATOR_HOSTILE_PRESUBMISSION_20260918.md` and is green for public pages, OAuth metadata/challenge fail-closed behavior, unauthenticated MCP, malicious Origin, forged Host and oversized JSON. Final G36 still requires the frozen final successor plus the real ChatGPT/reviewer/public-package path; release-blocking fixes would trigger affected recertification. |

## Blocking master gates

The ten currently blocked canonical gates are:

- **G13, G14** — real production OAuth/token/scopes evidence;
- **G24, G25** — public npm artifact, clean-machine and supply-chain completion;
- **G29** — final public software-license truthfulness;
- **G30** — real reviewer identity/pairing/journey;
- **G33, G34** — real ChatGPT E2E and OpenAI Scan Tools;
- **G35, G36** — final submission readiness and hostile frozen-candidate simulation.

## Cross-reference rule

Use `OPERATOR_RELEASE_GATE.md` for the compact submission verdict and this file for the canonical master-plan verdict. A PASS here must never be used to override a BLOCKED external/owner gate in the compact sheet. Any source/config/package change that changes the relevant candidate must update both views and rerun the affected evidence before release confirmation.
