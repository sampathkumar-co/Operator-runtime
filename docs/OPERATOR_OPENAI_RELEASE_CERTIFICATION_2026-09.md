# Operator OpenAI Release Certification — September 2026

## Candidate

- Candidate: **OCC-3M**
- Git commit: `405be7a03270c6c7ced78cd0d0d58314048a1af7`
- Production image: `sha256:7f1114f7f78843db9bf1f8ea7d94baf1a9914bbe42f07d2fbea67db980aaec18`
- Public MCP: `https://operator.splcart.in/mcp`
- OAuth issuer: `https://auth.splcart.in`
- Public plugin surface: 10 explicitly allowlisted MCP tools
- Evidence cutoff: 2026-09-17 21:10 UTC

This document is an engineering certification record, not a claim of OpenAI approval. OpenAI's portal scan and review remain external authorities.

## Current OpenAI requirements used

Rechecked on 18 September 2026 against official OpenAI documentation:

- MCP review: `https://developers.openai.com/plugins/deploy/app-review`
- Submission: `https://developers.openai.com/plugins/deploy/submission`
- Authentication: `https://developers.openai.com/plugins/build/auth`
- Security/privacy: `https://developers.openai.com/plugins/guides/security-privacy`
- App Developer Terms: `https://openai.com/policies/developer-apps-terms/`
- Usage Policies: `https://openai.com/policies/usage-policies/`

The submission baseline includes a publicly hosted production MCP server, accurate server-provided tool metadata/annotations, OAuth discovery for authenticated servers, domain verification when the portal issues a challenge, Scan Tools reconciliation, publisher identity verification, and at least five positive plus three negative reviewer tests.

## Exact-source CI evidence

All fresh post-merge workflows for OCC-3M completed successfully:

- CI #643 / run `35273370832`: PASS. Jobs include Core runtime tests, Security red-team suite, Performance regression suite, Public edge Linux container smoke, MCP v2 + Inspector E2E, Relay WebSocket E2E, Windows junction path authority, DPAPI helper, UIA native sidecar, dependency audit + CycloneDX SBOM, and Windows packaging.
- Platform Matrix #413 / run `35273370800`: PASS on Windows, macOS and Linux.
- NPM Remote Runtime CI #88 / run `35273370821`: PASS, including exact-source runtime payload and Node 22/24/26 launcher compatibility.
- Windows Signing Smoke #414 / run `35273370788`: PASS, including package build, signing verification and one-command npx readiness.

A separate CI-equivalent local Windows run built the DPAPI and path-lease native helpers and completed 361 tests with 345 passes, 16 expected skips and zero failures.

## OCC-3N package/publication successor

Draft PR #22 is a narrowly scoped successor to OCC-3M for npm/public-distribution hardening. Its exact head `fbd5e24542c81ca4f6bed4a5f8d49cf7f772e2da` removes automatic direct `npm publish`, defaults the first release to a CI-built immutable tarball + SHA-256 artifact with no registry mutation, and provides exact-tarball staged publication for later versions after the package exists. It also fail-closes public release while `UNLICENSED`, requires the declared license file to ship in the tarball, and requires root `DISCLOSURE` if a later owner decision declares the package dual-use.

Independent GitHub validation on this exact head is green: CI #659, Platform Matrix #429, NPM Remote Runtime CI #98 and Windows Signing Smoke #430 all PASS. Local release tests are 12/12 PASS and the full Windows suite is 361 tests / 345 pass / 16 expected skips / 0 failures with the required path-lease helper wired.

PR #22 deliberately does **not** choose the software license or npm dual-use classification. It remains draft and must not be merged or published until FG-013 and FG-015 are resolved, npm scope ownership/2FA is proven, and affected certification is rerun on the final successor SHA.

## Production identity and isolation

Production was promoted transactionally from the stale `60813bde...` edge to OCC-3M. Post-deploy inspection proves the running edge uses `operator-public-edge:405be7a0` and the exact image digest above; the production release checkout is clean at the OCC-3M commit.

The internal gateway is pinned to Caddy 2.11.4, has a read-only root filesystem, `no-new-privileges`, and only `CAP_NET_BIND_SERVICE` added after dropping other capabilities. The shared network places the outer reverse proxy at `172.16.3.10`, Operator at `172.16.3.20`, and Authelia at `172.16.3.30`. Backend ports 47200, 8788, 8789 and relay-control 8790 are not reachable from the public Internet.

## Live hostile edge results

External production probes after OCC-3M deployment and final outer-proxy reload produced the expected fail-closed behavior:

- TLS: TLS 1.3 with a valid `operator.splcart.in` certificate.
- Reviewer pages `/`, `/privacy`, `/terms`, `/support`: 200 with HSTS, CSP, `nosniff`, frame denial and no-referrer policy.
- SNI `operator.splcart.in` plus forged HTTP `Host: evil.example`: **421 Misdirected Request**.
- Browser `Origin: https://evil.example` to MCP: **403**.
- Missing bearer token to MCP: **401** with OAuth protected-resource challenge.
- Invalid bearer token: **401**.
- Unauthenticated device result/session-rotate/self-reset endpoints: **401**.
- Header larger than the configured public limit: **431**.
- MCP body larger than 1 MiB: **413** with connection close.
- Direct Internet probes to 47200/8788/8789/8790: blocked.

The hostile probes produced no fatal/panic/error signatures in recent Operator edge or gateway logs, and the edge remained healthy. SPLCART, attendance and auth hosts remained 200 after the shared-proxy hardening.

The wrong-Host issue discovered during this pass was fixed by adding `strict_sni_host on` to the outer Caddy configuration. The live and canonical VPS Caddyfiles were backed up before validation and hot reload. The true SPLCART source repository is not available through the connected GitHub installation, so repository-level persistence of this outer-proxy invariant remains an open P2 configuration-management gap.

## OAuth evidence

Production uses a predefined public OAuth client with S256 PKCE, exact ChatGPT callback `https://chatgpt.com/connector/oauth/8HymKNOT2aqK`, `operator:read` and `operator:write`, `offline_access`, explicit audience `https://operator.splcart.in/mcp`, authorization-code + refresh-token grants, and `token_endpoint_auth_method: none`.

The production provider preflight passes on the certified Node 22.23.2 runtime. Authelia's authoritative discovery advertises the expected authorization/token endpoints, S256, refresh-token support, JWKS and token authentication methods including `none`.

A real authorization request containing the exact client ID, callback, S256 challenge, Operator scopes, `offline_access` and MCP `resource` is accepted and redirects into Authelia's OIDC login flow. This proves the predefined client, callback and authorization request are accepted.

**Still required:** complete one real user authorization and code exchange, then inspect the issued access token and prove the exact MCP audience, issuer, expiry and required scopes. This evidence cannot be substituted by configuration inspection.

## Public MCP surface and reviewer package

`PUBLIC_PLUGIN_TOOL_NAMES` contains exactly 10 tools: `device.claim`, `computer.inspect`, `project.inspect`, `project.commands`, `file.list`, `file.read`, `file.create`, `file.replace`, `git.status`, and `git.diff`. Raw terminal, browser and UIA capabilities are intentionally absent from the public plugin surface.

`docs/plugin-review-package.json` contains matching annotation justifications for all 10 public tools, with no missing or extra entries, plus five positive and three negative reviewer tests. The external gate section is bound to OCC-3M and no longer describes production URLs as merely prospective.

## Legal and support surface

The production privacy, terms and support pages are deployment-specific, dated/current for this release, and contain no known placeholder markers. They describe hosted infrastructure, local execution authority, retention, security controls, account/device requests and a private security-reporting path at `support@splcart.in`.

OpenAI publisher identity verification is a separate portal gate. The live wording does not imply OpenAI endorsement or approval.

## Shared ingress persistence

The outer SPLCART deployment source that produced the running `c100a4e...` release was recovered locally at `C:/Users/SAMPATH/OneDrive/Desktop/splcart new`. Commit `e1d2207cf8ff05de7954b69480ef8a77e3f7077b` now persists the exact production Operator/Auth vhosts, `strict_sni_host on`, and external `operator_ingress` address `172.16.3.10`. A dependency-free contract check is wired into deployment-readiness CI so those invariants fail before a future storefront deployment. The local SPLCART Git repository currently has no configured remote; obtaining a remote/off-device backup remains an operational resilience task, not an unresolved public-release behavior defect.

## Reviewer fixture certification

A deterministic non-sensitive reviewer fixture is available at baseline commit `ab658c353fc3e0ce79d71e2968f53eedbc247537`. Using Node 22.23.2, an isolated local agent with the Windows path-lease helper, and the production `invokePublicWithAgent` boundary, all submitted five positive and three negative reviewer cases pass. Additional assertions prove destructive `file.replace` returns `APPROVAL_REQUIRED` without local approval and duplicate `file.create` returns `TARGET_EXISTS`. Reviewer positive #5 was changed from approval-gated `file.replace` to bounded `git.diff` so the submitted suite is self-service while the destructive approval boundary remains intact. This does not replace real production OAuth/ChatGPT reviewer execution.

## Remaining blockers before submission

The release is **not yet fully OpenAI-review certified**. The following evidence is still mandatory:

1. Real OAuth authorization/code exchange and issued-token audience/scope verification.
2. Real ChatGPT production E2E through OAuth -> MCP -> relay -> paired PC, including a read and a controlled write/approval flow.
3. Dedicated reviewer/demo credentials and fixture usable without MFA/SMS/email/private network.
4. OpenAI Platform individual/business verification for the chosen publisher name.
5. Portal domain verification if OpenAI issues a challenge token; never synthesize the token.
6. OpenAI **Scan Tools** against the exact production endpoint, followed by reconciliation of the imported 10-tool snapshot.
7. Resolve the remaining owner decisions on green draft successor PR #22: owner-approved software licensing plus explicit npm Dual-Use Content Policy classification, followed by affected recertification on the resulting exact successor SHA.
8. Prove `@mecrod` scope ownership with 2FA, build the final immutable first-release tarball from the green successor, publish that exact tarball interactively with 2FA, then pass clean-machine `doctor` and reviewer-root `remote` startup verification.
9. After `@mecrod/operator` exists, configure trusted publishing/staged promotion for future versions and verify the configured repository/workflow identity and stage-only release path.

Final submission itself is an external publication action and is not part of this certification pass unless explicitly authorized.

See `OPERATOR_RELEASE_GATE.md` for the binary 26-gate verdict, `OPERATOR_FEATURE_GAPS.md` for discovered/resolved/open gaps, and `OPERATOR_REMAINING_HUMAN_GATES.md` for the exact owner/portal procedure.
