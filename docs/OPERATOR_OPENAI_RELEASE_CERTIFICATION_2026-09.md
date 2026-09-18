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

The submission baseline includes a publicly hosted production MCP server, accurate server-provided tool metadata/annotations, OAuth discovery for authenticated servers, required square logo/composer-icon assets, domain verification when the portal issues a challenge, Scan Tools reconciliation, publisher identity verification, at least five positive plus three negative reviewer tests, and the reviewer-accessible demo recording required by the current remote-MCP submission flow.

## Exact-source CI evidence

All fresh post-merge workflows for OCC-3M completed successfully:

- CI #643 / run `35273370832`: PASS. Jobs include Core runtime tests, Security red-team suite, Performance regression suite, Public edge Linux container smoke, MCP v2 + Inspector E2E, Relay WebSocket E2E, Windows junction path authority, DPAPI helper, UIA native sidecar, dependency audit + CycloneDX SBOM, and Windows packaging.
- Platform Matrix #413 / run `35273370800`: PASS on Windows, macOS and Linux.
- NPM Remote Runtime CI #88 / run `35273370821`: PASS, including exact-source runtime payload and Node 22/24/26 launcher compatibility.
- Windows Signing Smoke #414 / run `35273370788`: PASS, including package build, signing verification and one-command npx readiness.

A separate CI-equivalent local Windows run built the DPAPI and path-lease native helpers and completed 361 tests with 345 passes, 16 expected skips and zero failures.

## OCC-3N package/publication successor

Draft PR #22 is a narrowly scoped successor to OCC-3M for npm/public-distribution hardening. Its exact head `bbcc12a7b5167345ab865af3f6c230580a2eda37` removes automatic direct `npm publish`, defaults the first release to a CI-built immutable tarball + SHA-256 artifact with no registry mutation, and provides exact-tarball staged publication for later versions after the package exists. It also fail-closes public release while `UNLICENSED`, requires the declared license file to ship in the tarball, explicitly permits root `DISCLOSURE` through the package file allowlist, requires it when dual-use is declared, and preserves any historical dual-use declaration by reading a bounded full npm package-history manifest with fail-closed identity/shape validation.

Independent GitHub validation on this exact head is green: CI #700, Platform Matrix #470, NPM Remote Runtime CI #128 and Windows Signing Smoke #471 all PASS. GitHub's NPM Runtime logs explicitly show the policy-continuity cases ran and passed. Local targeted release/policy tests are 18/18 PASS. A real npm 11.19.1 `npm stage publish <tgz> --dry-run` accepted the exact local tarball package-spec, synthetic owner-path probes proved both licensed non-dual-use and licensed dual-use (`LICENSE` + `DISCLOSURE`) tarballs pack correctly, and a live npm `socket` package-history probe proved historical dual-use metadata is detected outside `latest`. The full Windows-aware suite on this head is 367 tests / 351 pass / 16 expected skips / 0 failures with the required path-lease helper wired.

PR #22 deliberately does **not** choose the software license or npm dual-use classification. `OPERATOR_NPM_LICENSE_DECISION.md` records the licensing options and recommends a proprietary custom runtime license when the commercial intent is a publicly installable connector for the hosted Operator service without broad redistribution rights. `OPERATOR_NPM_POLICY_CLASSIFICATION.md` recommends the conservative engineering posture of treating Operator as dual-use unless npm Trust & Safety confirms otherwise. Both remain owner/npm decisions. PR #22 stays draft and must not be merged or published until FG-013 and FG-015 are resolved, npm scope ownership/2FA is proven, and affected certification is rerun on the final successor SHA.

## OCC-3R integrated Mecord Connect successor

Draft PR #27 is the current integrated release successor. Exact head `c0a87af4166a626b4aaea250438caa9fdbb00b08` combines the npm/publication hardening, source-controlled public notices, required OpenAI branding fields, and the product rebrand from **SPLCART Operator** to **Mecord Connect** across the actual public runtime surface. The manifest uses `name: mecord-connect` / `displayName: Mecord Connect` with a dedicated square SVG; OAuth protected-resource metadata advertises `resource_name: Mecord Connect`; public MCP initialize metadata advertises `name: mecord-connect` / `title: Mecord Connect`; generated landing/privacy/terms/support page titles, source notices, reviewer/submission package naming and README public-tool count are aligned. The old SPLCART favicon/public-plugin identity is removed. The Microsoft Store/MSIX display/artifact identity remains a separate distribution lane and was intentionally not renamed by the plugin rebrand. Legal publisher identity remains separately blocked under FG-017.

Exact-head GitHub validation is green: CI #745, Platform Matrix #515, NPM Remote Runtime CI #156 and Windows Signing Smoke #516 all PASS. The modified MCP public-edge/page E2E is 7 pass / 1 expected Windows symlink skip / 0 fail; local focused release tests are 28/28 PASS; the full Windows-aware suite is 368 tests / 352 pass / 16 expected skips / 0 failures.

PR #27 remains draft, unmerged, unpublished and undeployed. Production intentionally remains OCC-3M until owner licensing/npm-policy/publisher-identity decisions and the remaining real OAuth/npm/OpenAI gates are completed. Because the live OCC-3M pages still carry the pre-rebrand product name, final deployment must include the Mecord Connect notice/landing branding before submission.

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

A 2026-09-18 recheck found that Authelia advertises `authorization_response_iss_parameter_supported: true`, while the predefined client initially allowlisted only the callback-ID redirect. Current OpenAI authentication guidance can select the stable `https://chatgpt.com/connector_platform_oauth_redirect` for issuer-identifying authorization servers. The stable redirect was therefore added **alongside** the existing callback-ID URI after isolated Authelia configuration validation. Post-change preflight proves both redirect forms enter the real login flow, OIDC discovery remains healthy, and unauthenticated MCP still returns the expected 401 protected-resource challenge. A semantic comparison against the rollback copy proves the stable redirect line is the only provider-config difference. Discovery also advertises a UserInfo endpoint plus `openid`/`email` scopes and `email`/`email_verified` claims, covering OpenAI's discovery-side prerequisites for optional workspace domain restrictions. This provider-only configuration hardening did not change the OCC-3M source SHA or production edge image.

**Still required:** complete one real user authorization and code exchange, then inspect the issued access token and prove the exact MCP audience, issuer, expiry and required scopes. This evidence cannot be substituted by configuration inspection.

## Public MCP surface and reviewer package

`PUBLIC_PLUGIN_TOOL_NAMES` contains exactly 10 tools: `device.claim`, `computer.inspect`, `project.inspect`, `project.commands`, `file.list`, `file.read`, `file.create`, `file.replace`, `git.status`, and `git.diff`. Raw terminal, browser and UIA capabilities are intentionally absent from the public plugin surface.

`docs/plugin-review-package.json` contains matching annotation justifications for all 10 public tools, with no missing or extra entries, plus five positive and three negative reviewer tests. The external gate section is bound to OCC-3M and no longer describes production URLs as merely prospective.

## Legal and support surface

The production privacy, terms and support pages are deployment-specific and live. They describe hosted infrastructure, local execution authority, retention, security controls, account/device requests and a private security-reporting path at `support@splcart.in`.

A 2026-09-18 public-identity recheck found two release blockers that prevent treating this surface as final: **FG-017** because Operator names only "the publisher of splcart.in" while the SPLCART storefront still contains unresolved actual-business-entity/jurisdiction language, and **FG-018** because the canonical shared-VPS compose required `./production-notices` while that directory was ignored and absent from GitHub `main`. Draft PR #24 / OCC-3O source-controls the exact currently live notice bytes and regression-checks the bind-mount contract without changing their wording. PR #24 exact-head CI #710, Platform Matrix #480 and Windows Signing Smoke #481 all pass. A disposable integration preview combining PR #24 with frozen npm-hardening PR #22 was merge-clean, passed 24/24 focused release/deployment tests and the full Windows-aware suite at 367 tests / 351 pass / 16 expected skips / 0 fail. OpenAI publisher identity verification remains a separate portal gate and must use the exact owner-approved legal identity after FG-017 is resolved.

## Shared ingress persistence

The outer SPLCART deployment source that produced the running `c100a4e...` release was recovered locally at `C:/Users/SAMPATH/OneDrive/Desktop/splcart new`. Commit `e1d2207cf8ff05de7954b69480ef8a77e3f7077b` now persists the exact production Operator/Auth vhosts, `strict_sni_host on`, and external `operator_ingress` address `172.16.3.10`. A dependency-free contract check is wired into deployment-readiness CI so those invariants fail before a future storefront deployment. The local SPLCART Git repository currently has no configured remote; obtaining a remote/off-device backup remains an operational resilience task, not an unresolved public-release behavior defect.

## Reviewer fixture certification

A deterministic non-sensitive reviewer fixture is available at baseline commit `ab658c353fc3e0ce79d71e2968f53eedbc247537`. Using Node 22.23.2, an isolated local agent with the Windows path-lease helper, and the production `invokePublicWithAgent` boundary, all submitted five positive and three negative reviewer cases pass. Additional assertions prove destructive `file.replace` returns `APPROVAL_REQUIRED` without local approval and duplicate `file.create` returns `TARGET_EXISTS`. Reviewer positive #5 was changed from approval-gated `file.replace` to bounded `git.diff` so the submitted suite is self-service while the destructive approval boundary remains intact. `OPERATOR_REVIEWER_AUTH_EXECUTION.md` now defines the production-safe Authelia backup, interactive Argon2id hash generation, reviewer-only OIDC policy, validation, isolation, canonical-fixture pairing and rollback procedure. This preparation does not replace the still-required human-controlled production OAuth/ChatGPT reviewer execution.

## Hostile public-edge pre-submission probe

`OPERATOR_HOSTILE_PRESUBMISSION_20260918.md` records a fresh non-mutating OCC-3M probe. Public/legal/protected-resource endpoints remained available; the domain challenge remained fail-closed at 404 before a real token; unauthenticated MCP returned 401; malicious Origin returned 403; forged Host returned 421; non-JSON MCP input returned 415; and valid JSON above the 1 MiB request limit returned 413. This is useful pre-final evidence but does not close G36 because the final successor and real ChatGPT/reviewer/public-package path do not yet exist.

## Remaining blockers before submission

The release is **not yet fully OpenAI-review certified**. The following evidence is still mandatory:

1. Complete the real OAuth authorization/code exchange and issued-token audience/scope verification from the actual OpenAI draft.
2. Retrieve and verify the provisioned reviewer credential, prove no secondary verification is required, and pair only the canonical reviewer fixture/device.
3. Run real ChatGPT production E2E through OAuth -> MCP -> relay -> paired PC, including the submitted read/write cases, refusal cases, revoke/reconnect behavior, and independent local postcondition checks.
4. Resolve FG-017 with the exact owner-approved legal publisher identity/jurisdiction/contact, reconcile the Mecord Connect/SPLCART public legal pages plus manifest publisher fields, then complete OpenAI Platform individual/business verification using that same identity.
5. Resolve FG-013 and FG-015 on a descendant of green integrated PR #27: apply the owner-approved software license and npm Dual-Use Content Policy classification, then rerun affected exact-source/package/legal certification.
6. Prove `@mecrod` scope ownership with 2FA, build the final immutable first-release tarball from that final successor, publish that exact tarball interactively with 2FA, then pass clean-machine `doctor` and reviewer-root `remote` startup verification.
7. After `@mecrod/operator` exists, configure trusted publishing/staged promotion for future versions and verify the configured repository/workflow identity and stage-only release path.
8. Deploy the final Mecord Connect successor transactionally so `/`, `/privacy`, `/terms`, and `/support` visibly match the Mecord Connect listing while preserving the approved legal publisher identity; rerun public hostile/health checks on the deployed final SHA.
9. Complete portal domain verification if OpenAI issues a challenge token; never synthesize the token.
10. Run OpenAI **Scan Tools** against the exact final production endpoint and reconcile the imported 10-tool snapshot.
11. Execute `OPERATOR_DEMO_RECORDING_RUNBOOK.md`, host the required reviewer-accessible real-production demo recording, and add its URL to the submission package.
12. Select only owner-approved supported countries/regions, verify final listing/release notes, and submit only after every compact/canonical release gate above is PASS.

Final submission itself is an external publication action and is not part of this certification pass unless explicitly authorized.

See `OPERATOR_MASTER_GATE_STATUS.md` for the canonical G0–G36 master-plan verdict, `OPERATOR_RELEASE_GATE.md` for the compact binary 26-gate submission verdict, `OPERATOR_FEATURE_GAPS.md` for discovered/resolved/open gaps, and `OPERATOR_REMAINING_HUMAN_GATES.md` for the exact owner/portal procedure.
