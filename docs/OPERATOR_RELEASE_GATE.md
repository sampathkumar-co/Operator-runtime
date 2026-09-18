# Operator OpenAI Release Gate — OCC-3M

Certification candidate: `405be7a03270c6c7ced78cd0d0d58314048a1af7`
Production image: `sha256:7f1114f7f78843db9bf1f8ea7d94baf1a9914bbe42f07d2fbea67db980aaec18`
Production MCP: `https://operator.splcart.in/mcp`
Evidence cutoff: 2026-09-18 03:25 UTC

Status is deliberately binary: **PASS** means the OCC-3M release has direct evidence for the gate; **BLOCKED** means a required external/human step is still missing. Capabilities intentionally absent from the public MCP surface are treated as PASS only for public-release exposure and are called out explicitly. The canonical master-plan G0–G36 mapping is maintained separately in `OPERATOR_MASTER_GATE_STATUS.md`; neither numbering scheme overrides a blocker in the other.

| Gate | Status | Evidence / reason |
|---|---|---|
| G1 Source integrity | PASS | Production checkout is clean at exact OCC-3M SHA; running edge image ID matches the image built from that checkout. |
| G2 Runtime functionality | PASS | CI #643 Core runtime tests; Platform Matrix #413; live edge remains `running healthy`. |
| G3 Filesystem safety | PASS | Windows junction path-authority job passed; full Windows-aware suite passed 361 tests with 0 failures; public file tools enforce authorized roots and restricted-data guards. |
| G4 Command execution | PASS | Security red-team and core runtime suites passed. Public MCP exposes command *listing* only; raw terminal execution is not published. |
| G5 Browser safety | PASS | Browser control is not in `PUBLIC_PLUGIN_TOOL_NAMES`; no public OpenAI tool can invoke it. Internal runtime remains outside this public plugin surface. |
| G6 UIA safety | PASS | UIA is not in the public MCP surface; Windows UIA native sidecar compiled, tested, and passed clippy on OCC-3M. |
| G7 Policy enforcement | PASS | Cross-layer Security red-team suite passed; public surface is allowlisted to 10 tools and local policy remains authoritative. |
| G8 Approval integrity | PASS | Core runtime suite includes approval lifecycle, authority-generation, replay/expiry and recovery coverage; OCC-3M CI passed. |
| G9 Prompt-injection resistance | PASS | Public surface has no open-world browser tool; restricted paths/data are blocked and cross-layer adversarial boundary tests passed. |
| G10 Authentication | BLOCKED | Provider preflight, S256, predefined client, both currently documented OpenAI redirect forms are allowlisted and accepted into the real login flow, and authorization-request acceptance passes; one real human authorization/code exchange is still required. |
| G11 Authorization / scopes | BLOCKED | Static scope enforcement and wrong/missing token rejection pass. Final `resource -> access-token aud` and issued-scope proof requires the same real authorization. |
| G12 Device isolation | PASS | Account/device authority, A-B-A generation, release/rebind, disabled-account and quota tests passed; real paired-device relay E2E passed. |
| G13 Relay integrity | PASS | Relay WebSocket E2E passed; direct relay/result/control ports 8788/8789/8790 are unreachable from the Internet. |
| G14 Secret handling | PASS | DPAPI helper round-trip passed; public responses and legal pages exclude live secrets; invalid-token and restricted-data paths fail closed. |
| G15 Privacy / minimization | PASS | Production notices are live and placeholder-free; public tool surface is intentionally only 10 tools; result projection and retention bounds are documented/tested. |
| G16 OpenAI Usage Policy alignment | PASS | Public tools are bounded to authorized local development-project inspection/mutation and device claim; no raw terminal, browser or UIA tool is published. Final OpenAI review remains authoritative. |
| G17 Recovery / rollback | PASS | Core suite passed durable account/device cleanup and failure-recovery phases; production OCC-3M deployment retained a tested rollback compose. |
| G18 Audit integrity | PASS | Core/security suites passed audit/path-authority protections; no production secret/error leakage appeared during hostile probes. |
| G19 Packaging / supply chain | BLOCKED | PR #22 / OCC-3N head `bbcc12a7b5167345ab865af3f6c230580a2eda37` removes direct `npm publish`, provides an immutable artifact-only first-release path and exact-tarball staged path for later versions, makes root `DISCLOSURE` packable, enforces dual-use continuity across bounded published version history, and passes CI #700, Platform Matrix #470, NPM Runtime #128 and Signing Smoke #471. Local targeted release/policy tests are 18/18 PASS, the full Windows-aware suite is 367/351 pass/16 expected skips/0 fail, and npm 11.19.1 accepts the exact tarball form for staged publishing in dry-run. G19 remains BLOCKED until FG-013 licensing and FG-015 npm-policy classification are applied to the final successor, `@mecrod` ownership/2FA is proven, and affected publish/install certification is rerun. |
| G20 Production edge | PASS | TLS 1.3, valid certificate, HSTS/CSP, wrong Host -> 421, evil Origin -> 403, missing/invalid bearer -> 401, oversized header -> 431, oversized body -> 413. |
| G21 Performance / resource control | PASS | Performance regression suite passed; hostile bounded-input probes left the exact edge healthy with no crash/error signatures. |
| G22 Legal / public docs | BLOCKED | Mecord Connect source notices are ready in integrated PR #27, but production still serves pre-rebrand OCC-3M pages, the intended public npm package is UNLICENSED, and the exact legal publisher identity is not yet disclosed consistently. Owner-approved software licensing, exact publisher identity/legal-page reconciliation, and final Mecord Connect deployment are required before public distribution/submission. |
| G23 Real ChatGPT E2E | BLOCKED | Requires a ChatGPT plugin draft/connection plus completed OAuth login; no published/installed Mecord Connect plugin exists yet. |
| G24 OpenAI Scan Tools | BLOCKED | Must be run from the OpenAI submission portal against the exact production MCP endpoint. |
| G25 Reviewer simulation | BLOCKED | The deterministic reviewer project is locally certified: exact 5 positive + 3 negative public-boundary cases pass on Node 22.23.2, with additional `APPROVAL_REQUIRED` and duplicate-create checks. A dedicated production reviewer account and reviewer-only one-factor policy are now provisioned and Authelia is healthy. Remaining blockers are owner-side credential login verification, fixture-only pairing, public npm runtime, and real production OAuth/ChatGPT execution. |
| G26 Submission package | BLOCKED | Tool/test package and Mecord Connect branding are structurally ready in integrated PR #27, but final live branding deployment, npm runtime publication, publisher/legal identity verification, portal domain challenge, Scan Tools, reviewer credential login/pairing, authenticated E2E, and the required reviewer-accessible demo recording URL remain outstanding. |

## Remaining blocking actions

1. Complete one real OAuth authorization with the production predefined client and verify the issued access token has `aud=https://operator.splcart.in/mcp`, the required scopes, valid issuer/expiry, and succeeds against `/mcp`.
2. Create a dedicated reviewer/demo account and fixture using the reviewer-only one-factor design in `OPERATOR_REMAINING_HUMAN_GATES.md`; normal users remain two-factor.
3. Complete OpenAI Platform individual/business verification for the exact publisher name to be submitted.
4. Create the OpenAI plugin draft; if the portal issues a domain challenge, set only the exact token through `OPENAI_APPS_CHALLENGE_TOKEN`, reload the edge environment, and verify the exact well-known response.
5. Run **Scan Tools**, reconcile the imported 10-tool snapshot with the server metadata, then run a real ChatGPT read + write workflow through OAuth, relay and paired PC.
6. Resolve FG-013 and FG-015 on draft successor PR #22: choose the runtime software license, explicitly classify the package under npm's current Dual-Use Content Policy, add the required license/`DISCLOSURE` metadata as applicable, and rerun affected packaging/legal/clean-machine certification on the resulting exact successor SHA.
7. Prove `@mecrod` scope ownership with 2FA. For the first package release, use PR #22's CI-built immutable tarball and publish that exact artifact interactively with 2FA; after the package exists, configure trusted publishing with staged promotion for future versions. Then verify a clean-machine `npx ... doctor` and `remote --root <fixture>`.
8. Submit only after G10, G11, G19, G22, G23, G24, G25 and G26 change to PASS.

## OCC-3M merge evidence

- CI run `35273370832` / #643: all jobs passed, including Security red-team, performance, public-edge smoke, MCP v2 + Inspector E2E, relay E2E, Windows junction authority, DPAPI, UIA, SBOM and packaging.
- Platform Matrix run `35273370800` / #413: PASS on Windows, macOS and Linux.
- NPM Remote Runtime CI run `35273370821` / #88: PASS, including exact-source and launcher compatibility gates.
- Windows Signing Smoke run `35273370788` / #414: PASS, including package signing/verification and one-command npx readiness.
