# Public MCP Edge Deployment

Operator can expose its MCP adapter as a remote HTTPS resource server without exposing a paired user's local agent. Public mode is opt-in and routes every tool call through the relay authority.

## Security boundary

The supported production path is:

`ChatGPT -> HTTPS/TLS proxy -> Operator MCP edge -> loopback relay control -> relay -> paired device`

The local agent, relay-control service, and device credentials must never be directly internet-facing. A caller cannot choose an Operator account ID: the edge verifies the OAuth access token, extracts a verified `(issuer, subject)` principal, and the relay authority resolves that principal through `AccountDeviceRegistry`.

Public mode fails closed unless all of these are true:

- `OPERATOR_EXECUTION_MODE=relay`
- `OPERATOR_MCP_PUBLIC_EDGE=1`
- `OPERATOR_MCP_PUBLIC_BIND_ACK=TLS_TERMINATES_UPSTREAM`
- the public resource URL is a credential-free standard-port HTTPS URL ending exactly in `/mcp`
- public MCP and OAuth URLs use public DNS hostnames, not loopback, IP literals, or reserved/private namespaces
- OAuth authorization/token endpoints and either JWKS or introspection verification authority are configured
- the relay-control token is at least 32 characters and relay control remains loopback-only
- the public bind host is an explicit literal wildcard or loopback address

## Required environment

Use deployment secrets rather than committing values:

```text
OPERATOR_EXECUTION_MODE=relay
OPERATOR_RELAY_CONTROL_URL=http://127.0.0.1:8790
OPERATOR_RELAY_CONTROL_TOKEN=<secret, 32+ characters>
OPERATOR_MCP_PUBLIC_EDGE=1
OPERATOR_MCP_PUBLIC_BIND_ACK=TLS_TERMINATES_UPSTREAM
OPERATOR_MCP_HOST=127.0.0.1
OPERATOR_MCP_PORT=47200
OPERATOR_MCP_PUBLIC_URL=https://mcp.your-domain.tld/mcp
OPERATOR_OAUTH_ISSUER=https://auth.your-domain.tld
OPERATOR_OAUTH_AUTHORIZATION_URL=https://auth.your-domain.tld/authorize
OPERATOR_OAUTH_TOKEN_URL=https://auth.your-domain.tld/token
OPERATOR_OAUTH_VERIFICATION_MODE=jwks
OPERATOR_OAUTH_JWKS_URL=https://auth.your-domain.tld/.well-known/jwks.json
OPERATOR_OAUTH_AUDIENCE=https://mcp.your-domain.tld/mcp
OPERATOR_OAUTH_READ_SCOPE=operator:read
OPERATOR_OAUTH_WRITE_SCOPE=operator:write
OPERATOR_OAUTH_CLIENT_REGISTRATION_MODE=cimd
```

JWKS verification is the recommended production mode for providers such as Auth0. Operator accepts only RS256 in this mode, requires the JWKS endpoint to share the issuer origin, and requires `OPERATOR_OAUTH_AUDIENCE` to exactly equal `OPERATOR_MCP_PUBLIC_URL`.

For a provider that issues opaque access tokens, set `OPERATOR_OAUTH_VERIFICATION_MODE=introspection` and additionally configure `OPERATOR_OAUTH_INTROSPECTION_URL`, `OPERATOR_OAUTH_INTROSPECTION_CLIENT_ID`, and `OPERATOR_OAUTH_INTROSPECTION_CLIENT_SECRET`.

Binding the MCP process to `127.0.0.1` behind a same-host reverse proxy is preferred. Wildcard bind is available only for an explicitly isolated container/network topology and still requires the public-edge acknowledgement.

## TLS reverse proxy

Use the repository's canonical `deploy/public-edge/Caddyfile.example` for production ingress. It is validated against **Caddy 2.11.4** and production must use Caddy 2.11.4 or newer; older versions do not understand the complete hardened server policy.

The Caddy ingress exposes the public MCP/OAuth discovery surface, the exact reviewer website `/` plus read-only pages `/privacy`, `/terms`, and `/support`, the device WebSocket, and the six device lifecycle HTTP endpoints required by enrollment, result delivery, session rotation, and self-reset. Production notice content is **not** copied from the repository drafts. The operator must provide separately reviewed `privacy.md`, `terms.md`, and `support.md` files in `deploy/public-edge/production-notices/`; Compose mounts that directory read-only at `/run/operator-public-notices`. Public-edge startup and `certify:production-edge` both fail closed unless the files are present, bounded regular files, free of known repository-draft language, and `OPERATOR_PUBLIC_NOTICES_FINAL_ACK=I_CONFIRM_OPERATOR_PUBLIC_NOTICES_ARE_FINAL` is set. The fixed files are read and rendered once at process startup with HTML escaping and no request-controlled file path; responses add a restrictive content-security policy, same-origin resource policy, frame denial, and `nosniff`. Relay control on port `8790` is never proxied. The canonical file also applies bounded request bodies/headers, slow-request timeouts, strict SNI/Host handling, security headers, and bounded WebSocket reload behavior.

Before starting production ingress, validate the exact file with the pinned certification image:

```bash
docker run --rm -v "$PWD/deploy/public-edge/Caddyfile.example:/etc/caddy/Caddyfile:ro" caddy:2.11.4-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648 caddy validate --config /etc/caddy/Caddyfile
```

Do not substitute an older proxy snippet unless it exposes the exact same lifecycle routes and preserves the same TLS/request limits. Certificate/key configuration depends on the deployment environment.


## Finalized reviewer notices

The repository-root `PRIVACY.md`, `TERMS.md`, and `SUPPORT.md` files are technical/reference drafts and must **not** be published unchanged as production notices. Before starting the public edge:

```bash
mkdir -p deploy/public-edge/production-notices
# Place separately reviewed, deployment-specific privacy.md, terms.md and support.md here.
# Finalize controller/publisher contact, hosting regions/providers, actual retention, subprocessors,
# jurisdiction/consumer disclosures and the private security-reporting/support channel.
chmod 750 deploy/public-edge/production-notices
chmod 640 deploy/public-edge/production-notices/{privacy,terms,support}.md
```

Then replace the acknowledgement placeholder in `operator-edge.env` with exactly `I_CONFIRM_OPERATOR_PUBLIC_NOTICES_ARE_FINAL`. The notice directory is git-ignored, mounted read-only, and uses fixed filenames only. Missing files, a relative/symlinked directory, oversized/non-regular files, a missing acknowledgement, or known repository-draft wording stop the public edge before it listens.

## OAuth provider preflight

Before exposing the MCP edge, certify the configured production identity provider:

```bash
npm --prefix apps/mcp-server run certify:production-edge
```

The production preflight validates the public-edge environment and then fetches the provider discovery document without redirects. It fails closed unless the exact configured issuer, authorization, token, and selected verification endpoint (JWKS or introspection) match; `S256` PKCE is advertised; both Operator scopes are advertised; the authorization-code and refresh-token grants are supported; and the provider exposes the configured ChatGPT-compatible registration path. JWKS mode also requires local RS256 signature, issuer, audience, expiry, and scope verification for every MCP request. A real authorization flow is still required to prove that `resource` is echoed into the issued token audience and that the exact ChatGPT redirect URI is allowlisted.

## Startup order

1. Install the separately reviewed production notice files, set the exact final-notice acknowledgement, validate `deploy/public-edge/Caddyfile.example` with Caddy 2.11.4+, and run `npm --prefix apps/mcp-server run certify:production-edge`.
2. Start the relay delivery/result services and confirm paired-device routing independently.
3. Start the loopback relay-control service with `OPERATOR_RELAY_CONTROL_TOKEN`.
4. Start the MCP edge with the public-edge environment above.
5. Start the TLS reverse proxy only after the MCP process has passed its local health check.
6. Register the HTTPS `/mcp` resource with the supported ChatGPT/plugin workflow and complete a real OAuth authorization flow.

Never replace OAuth identity with a caller-provided `accountId`. The legacy `OPERATOR_RELAY_ACCOUNT_ID` route is retained only for private/single-account relay deployments; public-edge requests use the verified principal path.

## Certification checks

Before public registration, verify:

- `GET /.well-known/oauth-protected-resource/mcp` returns the canonical HTTPS MCP resource and authorization server
- `GET /.well-known/oauth-authorization-server` returns the configured OAuth server metadata
- `GET /` returns the intentional Operator reviewer landing page, while `GET /privacy`, `GET /terms`, and `GET /support` return the reviewed production-page sources over HTTPS; wrong Host/Origin values remain rejected
- `certify:production-edge` passes against the production environment and issuer, including S256 and CIMD/DCR registration compatibility
- a real authorization verifies the exact ChatGPT redirect URI and `resource` -> access-token audience binding
- unauthenticated `/mcp` receives `401` with a bearer challenge pointing at protected-resource metadata
- wrong `Host` and browser `Origin` values are rejected
- inactive, expired, wrong-audience, wrong-issuer and insufficient-scope tokens are rejected
- two distinct upstream subjects resolve to distinct Operator accounts
- relay control is unreachable from outside the host
- no raw OAuth bearer token, OAuth subject, issuer, JWKS response secret material, introspection secret, or relay-control secret is logged or persisted as plaintext by Operator

## Hardened VPS Compose bundle

The repository includes `deploy/public-edge/` for the recommended single-host VPS layout. Relay delivery, relay results, relay control, and the MCP edge run in one non-root container so relay control can remain bound only to container loopback. The host publishes only MCP, device WebSocket, and result HTTP ports to `127.0.0.1`; port `8790` is never published.

```bash
cp deploy/public-edge/operator-edge.env.example deploy/public-edge/operator-edge.env
mkdir -p deploy/public-edge/production-notices
# Install final reviewed privacy.md, terms.md and support.md in production-notices/.
chmod 600 deploy/public-edge/operator-edge.env
# Replace every placeholder, including the final-notice acknowledgement, before starting.
docker compose -f deploy/public-edge/compose.yml config --quiet
docker compose -f deploy/public-edge/compose.yml up -d --build --wait
docker compose -f deploy/public-edge/compose.yml ps
```

The container runs as the unprivileged `node` user with a read-only root filesystem, all Linux capabilities dropped, `no-new-privileges`, a bounded PID limit, a small no-exec tmpfs, and one persistent relay-state volume. The image is pinned to the current certified Node 22 security baseline rather than a floating runtime tag.
