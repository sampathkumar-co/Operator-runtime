# Operator Real OAuth Proof — G10/G11 Execution Runbook

Status: prepared, not executed.
Production MCP resource: `https://operator.splcart.in/mcp`.
Production issuer: `https://auth.splcart.in`.
Expected public scopes: `operator:read`, `operator:write`.

## Why this proof is still required

Static/provider preflight is already green, but OpenAI's current MCP authentication guidance requires the real authorization-code flow to carry the protected-resource `resource` value, use PKCE S256, and produce an access token that the MCP server accepts only for the expected issuer, audience/resource, expiration and scopes.

Authoritative reference:
- https://developers.openai.com/plugins/build/auth

The proof must exercise the actual ChatGPT connection. Do not substitute a locally minted token or a decoded example JWT.

## Existing production verification boundary

OCC-3M uses the production `OAuthJwtVerifier`, which calls `jose.jwtVerify` with:
- exact issuer from `OPERATOR_OAUTH_ISSUER`;
- exact audience from `OPERATOR_OAUTH_AUDIENCE`;
- `RS256` only;
- remote JWKS from the configured issuer;
- mandatory finite `exp`;
- bounded `sub`, client ID and scope claims.

Startup also refuses an OAuth audience that differs from the exact public MCP URL.

The public MCP handler additionally requires the read scope before MCP execution. Individual public mutating tools enforce the configured write scope before dispatch.

After verification, Operator sets `AuthInfo.token` to an empty string. The downstream principal conversion fails if a raw bearer token remains. This is intentional: certification evidence should prove the decision, not retain the credential.

## Phase A — Pre-flow snapshot

Immediately before connecting the OpenAI draft, re-check:

1. `GET https://operator.splcart.in/.well-known/oauth-protected-resource/mcp`;
2. unauthenticated `POST https://operator.splcart.in/mcp` returns 401 with protected-resource challenge;
3. issuer discovery at `https://auth.splcart.in/.well-known/openid-configuration` or the OAuth metadata endpoint;
4. issuer is exactly `https://auth.splcart.in`;
5. token/authorization endpoints are HTTPS and expected;
6. S256 is advertised;
7. the exact redirect URI currently shown by OpenAI app management is in the predefined-client allowlist; because this authorization server advertises authorization-response issuer identification, also keep the stable `https://chatgpt.com/connector_platform_oauth_redirect` allowlisted alongside the existing callback-ID URI;
8. public MCP remains healthy.

Retain the metadata JSON only if it contains no secret or transient authorization values.

### Current redirect preflight evidence

On 2026-09-18, the existing callback-ID URI entered the Authelia login flow while the stable OpenAI redirect initially failed with a redirect-URI mismatch. The stable URI was added alongside the existing callback-ID URI, the candidate Authelia configuration passed isolated validation, and only `operator-auth` was recreated. After activation, both redirect forms entered the login flow, OIDC discovery remained healthy, and unauthenticated MCP continued to return the expected 401 protected-resource challenge. The rollback backup SHA-256 is `a72142e64efdc0974f8f71814081038bdffda4f60e886dbdfcef2bd36e9717cc`; the activated config SHA-256 is `0236ccba6808b109763c31b54308fb3687fb8691c18cb178ff37740a5d1e7300`, and a semantic comparison confirmed the stable redirect line is the only configuration difference. This changed OAuth provider configuration only; the OCC-3M source SHA and production edge image did not change.

## Current live OAuth checkpoint — 2026-09-23

A real ChatGPT OAuth sign-in/reconnect completed against production source `10914835e5ce4d8b1d2bf9952e8789efc8feb306`. Tool definitions refreshed successfully, and a fresh ChatGPT conversation exposed exactly the canonical 9 tools with no `device.claim`. Production has since advanced to `a7fd8c960a82c9565b944ffb50535eeed6989c52`; that deployment preserves the same public OAuth/tool boundary and passed post-deploy health, routing and tool-count verification, while this paragraph remains the historical interactive OAuth proof.

After the local runtime reconnected, the same current 9-tool deployment completed real device-backed inspection/read/Git/write certification on Windows x64. `file.create` succeeded, the created file was immediately visible and read back with its SHA-256, Git observed the real new file, duplicate create returned `TARGET_EXISTS`, and `file.replace` reached local policy but returned `APPROVAL_REQUIRED` with no mutation. Evidence file: `test/mecord-public-v1-write-cert-20260923.txt`, SHA-256 `4761fc381cb93c7c04e04d3907ce4b14455c6b35b5b0f5a13397c0d79717da37`.

The remaining OAuth/E2E closure work is explicit disconnect/revoke failure + reconnect recovery, sanitized issued-token audience/scope evidence, and—separately from OAuth—a locally approved destructive replacement using the non-public approval authority.

## Phase B — Start the real ChatGPT authorization

Use the dedicated reviewer account after H2 is complete. Start authorization from the actual OpenAI plugin draft/connection rather than constructing the URL manually.

At the authorization page, verify only these non-secret facts:
- correct issuer/host;
- the redirect URI exactly matches the value selected by the current OpenAI app-management flow. Production now allowlists both `https://chatgpt.com/connector_platform_oauth_redirect` and the existing callback-ID URI `https://chatgpt.com/connector/oauth/8HymKNOT2aqK`; the portal-selected value is authoritative;
- `resource` is the exact production MCP resource;
- `code_challenge_method=S256`;
- requested scopes include what the selected tool requires.

Do not record `state`, authorization code, code challenge, PKCE verifier, cookies or credential values.

## Phase C — Cryptographic acceptance proof

After ChatGPT completes the code exchange, invoke a read-only public tool such as `project.inspect` on the canonical reviewer fixture.

A successful result through the production endpoint proves all of the following were accepted by the running verifier:
- bearer token signature against the production JWKS;
- exact configured issuer;
- exact configured audience `https://operator.splcart.in/mcp`;
- supported signing algorithm;
- valid expiration claim;
- valid subject/client claims;
- required `operator:read` scope;
- verified resource stored in `AuthInfo` matches the public MCP resource;
- verified principal could be resolved/routed without retaining the raw bearer token.

Record the tool name, UTC time, HTTP/MCP success status and fixture postcondition only.

## Phase D — Issued write-scope proof

Run the submitted safe write case against the disposable fixture:

```text
Create demo-project/src/reviewer-created.ts containing export const reviewer = true;
```

Before the test, reset the fixture so the target is absent. Independently verify the file appears with the exact requested content.

A successful `file.create` through the real ChatGPT connection proves the issued auth context contained the configured write authority because the public boundary checks the write scope before local dispatch.

Reset the fixture after recording the non-secret outcome.

## Phase E — Negative/revocation proof

The real-flow proof is incomplete if only a happy-path token works.

Verify at least these failure/recovery behaviors:

1. disconnect/revoke the ChatGPT connection or reviewer authorization using the supported product/provider mechanism;
2. confirm the old connection can no longer successfully invoke the MCP server after revocation takes effect;
3. reconnect and confirm a fresh authorization succeeds;
4. verify an unauthenticated request still returns 401 with the correct protected-resource challenge;
5. retain the existing automated evidence that malformed, expired, wrong-audience and missing/wrong-scope tokens fail closed.

Do not intentionally forge or replay a real reviewer token outside the supported connection merely to produce evidence.

If the provider exposes a safe revocation event/status, retain the status/time only.

## Resource-parameter evidence

OpenAI currently documents that ChatGPT sends the protected-resource `resource` value on both authorization and token requests. Confirm the authorization-request value directly during the real flow.

For the token request, prefer existing provider/reverse-proxy telemetry **only if** it can prove the presence/equality of the `resource` field without logging request bodies, codes, client assertions, verifier values or tokens. Do not enable verbose OAuth request-body logging just for certification.

If no safe token-request telemetry exists, record:
- OpenAI's documented token-request behavior;
- successful production token acceptance against the exact resource audience;
- the running server's startup invariant that audience equals the exact MCP resource.

Do not weaken privacy controls solely to obtain a second copy of the same binding evidence.

## Permitted evidence

Retain:
- draft/plugin identifier if OpenAI exposes one;
- exact redirect URI shown/selected by OpenAI app management (stable or callback-ID form);
- protected-resource URL;
- issuer URL;
- PKCE method = S256;
- required/granted scope **names**;
- successful read/write tool names and timestamps;
- expected fixture postconditions;
- revocation/reconnect outcomes;
- sanitized HTTP status/error category;
- relevant workflow/release SHA and production image identity.

Never retain:
- access/refresh/ID tokens;
- authorization code;
- PKCE verifier or code challenge;
- client assertion/private key;
- reviewer password;
- cookies/session storage;
- raw Authorization headers;
- raw provider request bodies.

## G10 closure rule

The production Mecord Connect OAuth flow has completed against the live public edge and real paired-device requests have succeeded. Authentication/runtime release evidence is no longer blocked by the earlier offline-device probe. Any additional revoke/reconnect capture or reviewer-specific proof belongs to the later OpenAI submission evidence set.

## G11 closure rule

G11 Authorization / scopes may move to PASS only when:
- the real authenticated read case succeeds;
- the real authenticated safe write case succeeds;
- the production server remains configured with exact resource audience and separate read/write scopes;
- existing negative wrong/missing-scope tests remain green;
- no evidence indicates a token for another resource/issuer can pass.

A browser redirect alone, a login screenshot, or a token decoded without signature verification is not sufficient.
