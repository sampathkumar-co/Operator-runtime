# Operator OpenAI Release Gate — OCC-3M

Frozen production source: `405be7a03270c6c7ced78cd0d0d58314048a1af7`
Current release successor: `11abc578488f5deb4df83299554b6a4eae3bbe2e`
Current exact-main certification: merge `2e6cff8b56044ad78de7942d799b1e0191070ed9`; CI #806 / Platform Matrix #576 / NPM Runtime #206 / Signing #577 — all PASS. Production remains on the older OCC-3M deployment until the transactional final deployment gate is executed.
Production image: `sha256:7f1114f7f78843db9bf1f8ea7d94baf1a9914bbe42f07d2fbea67db980aaec18`
Production MCP: `https://operator.splcart.in/mcp`
Evidence date: 2026-09-18

Status is deliberately binary: **PASS** means the OCC-3M release has direct evidence for the gate; **BLOCKED** means a required external/human step is still missing. Capabilities intentionally absent from the public MCP surface are treated as PASS only for public-release exposure and are called out explicitly. The canonical master-plan G0–G36 mapping is maintained separately in `OPERATOR_MASTER_GATE_STATUS.md`; neither numbering scheme overrides a blocker in the other.

| Gate | Status | Evidence / reason |
|---|---|---|
| G1 Source integrity | PASS | Production checkout is clean at exact OCC-3M SHA; running edge image ID matches the image built from that checkout. |
| G2 Runtime functionality | PASS | CI #643 Core runtime tests; Platform Matrix #413; live edge remains `running healthy`. |
| G3 Filesystem safety | PASS | Windows junction path-authority job passed; full Windows-aware suite passed 361 tests with 0 failures; public file tools enforce authorized roots and restricted-data guards. |
| G4 Command execution | PASS | Security red-team and core runtime suites passed. Public MCP exposes command *listing* only; raw terminal execution is not published. |
| G5 Browser safety | PASS | Browser control is not in `PUBLIC_PLUGIN_TOOL_NAMES`; no public OpenAI tool can invoke it. Internal runtime remains outside this public plugin surface. |
| G6 UIA safety | PASS | UIA is not in the public MCP surface; Windows UIA native sidecar compiled, tested, and passed clippy on OCC-3M. |
| G7 Policy enforcement | PASS | Cross-layer Security red-team suite passed; public surface is allowlisted to 9 tools and local policy remains authoritative. |
| G8 Approval integrity | PASS | Core runtime suite includes approval lifecycle, authority-generation, replay/expiry and recovery coverage; OCC-3M CI passed. |
| G9 Prompt-injection resistance | PASS | Public surface has no open-world browser tool; restricted paths/data are blocked and cross-layer adversarial boundary tests passed. |
| G10 Authentication | BLOCKED | Provider preflight, S256, predefined client, both currently documented OpenAI redirect forms are allowlisted and accepted into the real login flow, and authorization-request acceptance passes; one real human authorization/code exchange is still required. |
| G11 Authorization / scopes | BLOCKED | Static scope enforcement and wrong/missing token rejection pass. Final `resource -> access-token aud` and issued-scope proof requires the same real authorization. |
| G12 Device isolation | PASS | Account/device authority, A-B-A generation, release/rebind, disabled-account and quota tests passed; real paired-device relay E2E passed. |
| G13 Relay integrity | PASS | Relay WebSocket E2E passed; direct relay/result/control ports 8788/8789/8790 are unreachable from the Internet. |
| G14 Secret handling | PASS | DPAPI helper round-trip passed; public responses and legal pages exclude live secrets; invalid-token and restricted-data paths fail closed. |
| G15 Privacy / minimization | PASS | Production notices are live and placeholder-free; public tool surface is intentionally only 9 tools; result projection and retention bounds are documented/tested. |
| G16 OpenAI Usage Policy alignment | PASS | Public tools are bounded to authorized local development-project inspection/mutation and device claim; no raw terminal, browser or UIA tool is published. Final OpenAI review remains authoritative. |
| G17 Recovery / rollback | PASS | Core suite passed durable account/device cleanup and failure-recovery phases; production OCC-3M deployment retained a tested rollback compose. |
| G18 Audit integrity | PASS | Core/security suites passed audit/path-authority protections; no production secret/error leakage appeared during hostile probes. |
| G19 Packaging / supply chain | BLOCKED | The candidate uses unscoped `mecord-connect`, proprietary `LICENSE`, mandatory dual-use `DISCLOSURE`, exact author metadata, immutable first-release artifact handling and staged future-release controls. npm account `mecrod` and 2FA mode `auth-and-writes` were previously verified; the publication shell must re-authenticate immediately before release and must not treat a stale CLI session as publication authority. No npm organization/scope is required. G19 remains BLOCKED until the exact first tarball is explicitly authorized/published and public-registry/clean-machine verification passes. |
| G20 Production edge | PASS | TLS 1.3, valid certificate, HSTS/CSP, wrong Host -> 421, evil Origin -> 403, missing/invalid bearer -> 401, oversized header -> 431, oversized body -> 413. |
| G21 Performance / resource control | PASS | Performance regression suite passed; hostile bounded-input probes left the exact edge healthy with no crash/error signatures. |
| G22 Legal / public docs | BLOCKED | Source legal materials now identify **Kinthala Samuel Sampath Kumar**, Akkayapalem/Visakhapatnam/Andhra Pradesh/India, support@splcart.in, India governing law, and the proprietary Mecord Connect runtime license. Production still serves OCC-3M/pre-final pages, and OpenAI individual publisher verification is not yet complete. Final live deployment + identity-verification consistency are required before submission. |
| G23 Real ChatGPT E2E | BLOCKED | Requires a ChatGPT plugin draft/connection plus completed OAuth login; no published/installed Mecord Connect plugin exists yet. |
| G24 OpenAI Scan Tools | BLOCKED | Must be run from the OpenAI submission portal against the exact production MCP endpoint. |
| G25 Reviewer simulation | BLOCKED | The deterministic reviewer project is locally certified: exact 5 positive + 3 negative public-boundary cases pass on Node 22.23.2, with additional `APPROVAL_REQUIRED` and duplicate-create checks. A dedicated production reviewer account and reviewer-only one-factor policy are now provisioned and Authelia is healthy. Remaining blockers are owner-side credential login verification, fixture-only pairing, public npm runtime, and real production OAuth/ChatGPT execution. |
| G26 Submission package | BLOCKED | Mecord Connect source/listing/package/legal metadata are owner-resolved, but final live deployment, npm publication, OpenAI individual verification, reviewer credential login/pairing, portal domain challenge if issued, Scan Tools, authenticated E2E, required demo recording, and final region selection in the portal remain outstanding. |

## Remaining blocking actions

Only five owner/external categories remain:

1. **OpenAI publisher/developer verification** ? verify the exact individual identity and reconcile spelling/order if needed.
2. **Reviewer credential entry / real pairing** ? owner-controlled credential entry and canonical fixture pairing.
3. **Portal domain challenge if issued** ? use only the real OpenAI token.
4. **Real OAuth / Scan Tools / reviewer E2E / demo** ? exact 9-tool scan, issued-token proof, reviewer cases, revoke/reconnect and demo recording.
5. **Explicit irreversible publication / deployment / submission authorization** ? exact `mecord-connect` tarball publication with 2FA, final transactional deployment, then OpenAI Submit for Review only after final proof.

npm account setup itself is resolved: user `mecrod`, authenticated, 2FA `auth-and-writes`; no npm organization/scope is required.

## OCC-3M merge evidence

- CI run `35273370832` / #643: all jobs passed, including Security red-team, performance, public-edge smoke, MCP v2 + Inspector E2E, relay E2E, Windows junction authority, DPAPI, UIA, SBOM and packaging.
- Platform Matrix run `35273370800` / #413: PASS on Windows, macOS and Linux.
- NPM Remote Runtime CI run `35273370821` / #88: PASS, including exact-source and launcher compatibility gates.
- Windows Signing Smoke run `35273370788` / #414: PASS, including package signing/verification and one-command npx readiness.
