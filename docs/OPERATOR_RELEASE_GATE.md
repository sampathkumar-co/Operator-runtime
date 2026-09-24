# Mecord Connect OpenAI Submission Gate — public product v1.0.0 / runtime v1.0.1

Current production source: `10914835e5ce4d8b1d2bf9952e8789efc8feb306`
Current public package: `mecord-connect@1.0.1` (`latest`)
Deployment evidence: 19/19 CI checks green; runtime suite 437 passed / 17 expected skips / 0 failures; production health/OAuth/routing/security checks passed; fresh ChatGPT connection imported exactly 9 tools with no `device.claim`.
Rollback baseline: OCC-3M `405be7a03270c6c7ced78cd0d0d58314048a1af7` / image `sha256:7f1114f7f78843db9bf1f8ea7d94baf1a9914bbe42f07d2fbea67db980aaec18`
Production MCP: `https://operator.splcart.in/mcp`
Evidence date: 2026-09-24

Status is deliberately binary: **PASS** means the current Mecord Connect v1 release has direct evidence for the gate; **BLOCKED** means a required external/human step is still missing. Capabilities intentionally absent from the public MCP surface are treated as PASS only for public-release exposure and are called out explicitly. The canonical master-plan G0–G36 mapping is maintained separately in `OPERATOR_MASTER_GATE_STATUS.md`; neither numbering scheme overrides a blocker in the other.

| Gate | Status | Evidence / reason |
|---|---|---|
| G1 Source integrity | PASS | Production is deployed from exact source `10914835e5ce4d8b1d2bf9952e8789efc8feb306`; the production health/provenance endpoint and post-deploy verification bind the live edge to the final v1 source candidate. |
| G2 Runtime functionality | PASS | Final deployment evidence reports 19/19 CI checks green and 437 passed / 17 expected skips / 0 failures; production health and routing checks passed after deployment. |
| G3 Filesystem safety | PASS | Windows junction path-authority job passed; full Windows-aware suite passed 361 tests with 0 failures; public file tools enforce authorized roots and restricted-data guards. |
| G4 Command execution | PASS | Security red-team and core runtime suites passed. Public MCP exposes command *listing* only; raw terminal execution is not published. |
| G5 Browser safety | PASS | Browser control is not in `PUBLIC_PLUGIN_TOOL_NAMES`; no public OpenAI tool can invoke it. Internal runtime remains outside this public plugin surface. |
| G6 UIA safety | PASS | UIA is not in the public MCP surface; Windows UIA native sidecar compiled, tested, and passed clippy on OCC-3M. |
| G7 Policy enforcement | PASS | Cross-layer security coverage remains green. Production now exposes exactly the canonical 9-tool public surface with web pairing; `device.claim` is absent. Local policy remains authoritative. |
| G8 Approval integrity | PASS | Core runtime suite includes approval lifecycle, authority-generation, replay/expiry and recovery coverage; OCC-3M CI passed. |
| G9 Prompt-injection resistance | PASS | Public surface has no open-world browser tool; restricted paths/data are blocked and cross-layer adversarial boundary tests passed. |
| G10 Authentication | PASS | Real ChatGPT OAuth sign-in/reconnect completed against production and real paired-device requests succeeded. Earlier offline-device evidence is superseded. Reviewer-specific revoke/reconnect capture may still be collected for submission evidence. |
| G11 Authorization / scopes | PASS | Public read/write scope enforcement is production-proven. The Developer endpoint additionally requires `operator:developer` plus explicit account entitlement and fails closed for non-entitled accounts. |
| G12 Device isolation | PASS | Account/device authority, A-B-A generation, release/rebind, disabled-account and quota tests passed; real paired-device relay E2E passed. |
| G13 Relay integrity | PASS | Relay WebSocket E2E passed; direct relay/result/control ports 8788/8789/8790 are unreachable from the Internet. |
| G14 Secret handling | PASS | DPAPI helper round-trip passed; public responses and legal pages exclude live secrets; invalid-token and restricted-data paths fail closed. |
| G15 Privacy / minimization | PASS | Final Mecord Connect notices are live and placeholder-free. Production exposes exactly 9 bounded public tools; result projection and retention bounds remain documented/tested. |
| G16 OpenAI Usage Policy alignment | PASS | Public tools are bounded to authorized local development-project inspection/mutation; authenticated web pairing remains outside the public tool set, and no raw terminal, browser or UIA tool is published. Final OpenAI review remains authoritative. |
| G17 Recovery / rollback | PASS | Core suite passed durable account/device cleanup and failure-recovery phases; production OCC-3M deployment retained a tested rollback compose. |
| G18 Audit integrity | PASS | Core/security suites passed audit/path-authority protections; no production secret/error leakage appeared during hostile probes. |
| G19 Packaging / supply chain | PASS | `mecord-connect@1.0.1` is public under `latest`, published through interactive npm authorization from source `10914835e5ce4d8b1d2bf9952e8789efc8feb306`. Clean registry install, installed `doctor`, `remote --help`, package/runtime file verification and vulnerability scan passed; 0 vulnerabilities were reported. |
| G20 Production edge | PASS | TLS 1.3, valid certificate, HSTS/CSP, wrong Host -> 421, evil Origin -> 403, missing/invalid bearer -> 401, oversized header -> 431, oversized body -> 413. |
| G21 Performance / resource control | PASS | Performance regression suite passed; hostile bounded-input probes left the exact edge healthy with no crash/error signatures. |
| G22 Legal / public docs | BLOCKED | Final Mecord Connect public pages are deployed with the selected publisher/locality/support/license wording. Remaining blocker is OpenAI individual publisher verification and any reconciliation required by the verified legal-name spelling/order. |
| G23 Real ChatGPT E2E | PASS | Real ChatGPT OAuth and the deployed 9-tool surface pass paired-Windows inspect/read/Git/create/read-back checks. Duplicate create and local approval boundaries fail closed as designed; session approval/continuation is release-certified. Reviewer-only exercises remain submission work. |
| G24 OpenAI Scan Tools | BLOCKED | Must be run from the OpenAI submission portal against the exact production MCP endpoint. |
| G25 Reviewer simulation | BLOCKED | Public device routing and real write semantics are now proven on a paired Windows x64 runtime. The dedicated reviewer credential/fixture journey itself remains pending, along with final reset/reproducibility of the submitted five positive + three negative reviewer cases under reviewer authority. |
| G26 Submission package | BLOCKED | Final deployment, npm publication, public 9-tool operation and Developer 24-tool hosting are complete. Remaining work is OpenAI verification plus whatever portal/reviewer/Scan Tools/demo steps become available after that external gate is resolved. |

## Remaining blocking actions

The software/runtime release is complete. Only OpenAI directory-submission work remains:

1. **Resolve OpenAI individual/developer verification.**
2. **Complete portal-only reviewer / Scan Tools / demo steps after verification becomes available.**
3. **Serve a portal-issued challenge only if OpenAI actually issues one.**
4. **Select Submit for Review only after the owner explicitly decides to pursue directory publication.**

`mecord-connect@1.0.1` is public under `latest`; npm, production hosting, the public 9-tool surface and the separate 24-tool Developer endpoint are not release blockers.

## OCC-3M merge evidence

- CI run `35273370832` / #643: all jobs passed, including Security red-team, performance, public-edge smoke, MCP v2 + Inspector E2E, relay E2E, Windows junction authority, DPAPI, UIA, SBOM and packaging.
- Platform Matrix run `35273370800` / #413: PASS on Windows, macOS and Linux.
- NPM Remote Runtime CI run `35273370821` / #88: PASS, including exact-source and launcher compatibility gates.
- Windows Signing Smoke run `35273370788` / #414: PASS, including package signing/verification and one-command npx readiness.
