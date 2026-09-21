# Mecord Connect account portal

This service provides the browser account surface used in production at `/signup`,
`/pair`, and at the OpenID Connect login entry. The OAuth entry presents Sign in
and Create account together, then sends password authentication directly from the
browser to Authelia's `/api/firstfactor` endpoint while preserving the original
OIDC flow parameters. The service itself never receives sign-in passwords.

Device enrollment is self-service through `/pair`: the user enters the one-time
code printed by `mecord-connect remote`, the portal starts a short-lived PKCE
flow with the dedicated `mecord-device-pairing-v1` client, exchanges the code
server-side, and calls the public edge's narrow bearer-authenticated
`POST /pair/api/claim` endpoint. The browser never receives the relay control
token, raw OAuth access token, internal account ID, or OIDC subject.

It is intentionally separate from Authelia and writes only newly registered
accounts to Authelia's file user database through a shared writable users
directory.

## Required deployment contract

- `PORTAL_INVITE_SHA256`: SHA-256 of the out-of-band registration code. Generate
  a human-friendly random code with `node generate-registration-code.mjs <output-dir>`;
  codes use the form `MCRD-XXXX-XXXX` and avoid ambiguous characters. Never keep
  the plaintext registration code on the server after handoff.
- `PORTAL_USERS_FILE`: shared Authelia user database path.
- `PORTAL_DEFAULT_GROUP`: normal signup group; production uses
  `operator-users`.
- Reverse proxy `/signup`, `/signup/*`, `/recover`, `/pair`, `/pair/*`, and the
  active root/consent OAuth entry (`/?flow=openid_connect&flow_id=...`) to this service.
- Configure the dedicated public PKCE client `mecord-device-pairing-v1` with only
  `https://auth.splcart.in/pair/callback` as its redirect URI, `authorization_code`
  grant, `openid operator:read operator:write` scopes, and the MCP resource audience.
- Expose Authelia publicly only for machine-facing endpoints: `/api/*`,
  `/.well-known/*`, and `/jwks.json`.
- Do not expose Authelia's browser UI routes such as `/settings`, `/2fa/*`,
  `/consent/*`, password-reset pages, or its generic portal root. Any browser
  route outside the Mecord surface is rewritten to `/recover`.
- `/api/firstfactor` and the OIDC endpoints remain owned by Authelia; the
  Mecord browser calls those APIs directly without exposing the Authelia UI.
- Authelia must mount the same user database read-only and enable its file
  watcher so atomic portal updates reload without restarts.

Passwords are hashed in-process with Argon2id using the production Authelia
parameters: 64 MiB memory, 3 iterations, parallelism 4, 32-byte output.
Passwords are never written to logs, YAML, environment variables, or process
arguments.

## Account and device model

Authentication creates/resolves one Operator account from the upstream
issuer+subject principal. Device enrollment is independent of signup: each
computer has its own Ed25519 device identity and may be bound to the same
account after that account authenticates.

The runtime currently permits up to 32 active devices per account and retains
up to 128 historical device identities per account. A device cannot be active
under two accounts at the same time.
