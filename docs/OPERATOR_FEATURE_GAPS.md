# Operator Feature / Gap Register — OCC-3M

This register records gaps discovered by the adversarial release-certification program. A gap is closed only when the fix exists at the correct authority boundary and has regression evidence.

| ID | Severity | Status | Gap | Resolution / remaining action |
|---|---|---|---|---|
| FG-001 | P1 | RESOLVED | Shared-VPS Operator gateway repair was live-only and not reproducible from Operator source. | PR #20 source-controlled the shared-VPS compose + internal Caddy contract, exact `.10 -> .20` trust topology, pinned Caddy, and `NET_BIND_SERVICE` requirement. CI and real Caddy parser passed. |
| FG-002 | P1 | RESOLVED-LIVE | TLS SNI `operator.splcart.in` with HTTP `Host: evil.example` returned an empty 200 from the outer shared Caddy. | Added global `strict_sni_host on`; exact failure now returns 421 while Operator, SPLCART, attendance and auth remain 200. Both active and canonical VPS Caddyfiles were backed up and patched. |
| FG-003 | P2 | OPEN | The shared outer SPLCART Caddy source is not available in the connected GitHub installation, so FG-002 cannot yet be proven persistent across a future clean SPLCART deployment. | Put the same `strict_sni_host on` invariant into the real SPLCART deployment repository/config source when that repository is available; add a wrong-SNI/Host regression test. |
| FG-004 | P0-release | BLOCKED-EXTERNAL | Real OAuth token audience/scopes have not been observed from a completed production authorization-code flow. | Complete one human login/consent, exchange the code with PKCE, verify `aud=https://operator.splcart.in/mcp`, issuer, expiry and scopes, then invoke `/mcp`. |
| FG-005 | P2-release | BLOCKED-EXTERNAL | OpenAI domain verification token has not been issued. | Create/open the plugin draft; if the portal presents Domain not verified, host only the exact supplied token at `/.well-known/openai-apps-challenge`. Current 404 is intentional. |
| FG-006 | P2-release | BLOCKED-EXTERNAL | No dedicated reviewer account/fixture has been certified for OpenAI review. | Provision a disposable reviewer identity + paired demo device/project; credentials must run submitted tests without MFA/SMS/email confirmation/private network. |
| FG-007 | P2-release | BLOCKED-EXTERNAL | OpenAI Scan Tools has not imported the production MCP metadata. | Run Scan Tools after draft/auth configuration; reconcile names, titles, descriptions, schemas, security schemes, annotations, `_meta`, instructions and domains against OCC-3M. |
| FG-008 | P2-release | BLOCKED-EXTERNAL | Real ChatGPT end-to-end read/write workflow has not run through production OAuth -> MCP -> relay -> paired PC. | Connect the draft in ChatGPT and execute at least one read-only and one write/approval flow, then revoke/reconnect and verify failure/recovery behavior. |
| FG-009 | P2-release | BLOCKED-EXTERNAL | Publisher identity verification state is not proven. | Complete individual or business verification in the OpenAI Platform Dashboard for the exact directory publisher name. |
| FG-010 | P3 | DOCUMENTED | Operator's convenience mirror at `/.well-known/oauth-authorization-server` does not echo `token_endpoint_auth_methods_supported`. | Not a blocker: protected-resource metadata points to `https://auth.splcart.in`, whose authoritative discovery advertises `none` and other accepted methods. Consider mirroring it in a later cleanup release. |

## Closed production drift

Before OCC-3M, production Operator was still executing the old `60813bde...` edge while the certified source had advanced. OCC-3M deployment replaced that drift with the exact merge source `405be7a...` and image `sha256:7f1114f7...`. Production source/image identity is now directly evidenced.

## Feature-creep rule

No new public capability is added merely because it is convenient. A new public tool or permission must be justified by a concrete user workflow, mapped to OpenAI policy, have least-privilege OAuth/security metadata, failure/approval semantics, privacy projection, adversarial tests, and fresh Scan Tools review before release.
