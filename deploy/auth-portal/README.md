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

- `PORTAL_SIGNUP_MODE`: `invite` (default, preserving existing access restrictions)
  or `open` (normal username/email/password registration without an invitation).
  Enable `open` explicitly in the production portal container environment only
  after verifying ingress rate limits, bot-abuse monitoring, and account quotas.
- `PORTAL_INVITE_SHA256`: required only in `invite` mode. SHA-256 of the
  out-of-band registration code. Generate a random code with
  `node generate-registration-code.mjs <output-dir>`; codes use the form
  `MCRD-XXXX-XXXX`. Never keep the plaintext code on the server after handoff.
  Open mode ignores this value, so rolling back to `invite` does not require
  resetting existing users.
- `PORTAL_USERS_FILE`: shared Authelia user database path.
- `PORTAL_DEFAULT_GROUP`: normal signup group. Open mode fails closed unless this
  is exactly `operator-users`.
- `PORTAL_CHALLENGE_SECRET`: at least 32 random characters. Required in open
  mode to authenticate client-bound, three-second browser signup challenges. Keep
  this value stable across portal restarts and replicas; it is not an Authelia
  credential.
- `PORTAL_TRUSTED_PROXY_IPS`: **required in both `invite` and `open` modes**;
  comma-separated exact proxy addresses allowed to supply `X-Real-IP`.
  Before upgrading the existing invite portal image, configure the effective
  Caddy peer address or the portal intentionally refuses to start, preventing
  invite and device-pairing clients from being incorrectly rate-limited under
  a shared proxy address. Production uses the shared Caddy address. Requests
  from any other peer ignore the header.
- `PORTAL_SECURITY_STATE_FILE`: persistent signup limiter/quota state. Defaults
  to `<PORTAL_USERS_FILE>.portal-security.json` and must be on the same durable
  writable volume.
- `PORTAL_MAX_USERS`: hard ceiling for all file-backed users. Required in open
  mode and must be set above the verified existing account count.
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

Open signup uses a persistent four-attempt-per-client, 15-minute limit and a
signed, client-bound, time-gated browser challenge. The browser waits using a
relative delay measured with `performance.now()` rather than comparing client
and server wall clocks. Invite signup uses a persistent eight-attempt
limit. The portal stores only an HMAC of each client address, trusts forwarded
addresses only from configured proxy peers, and has no attacker-exhaustible
global attempt counter. The persistent total-user quota bounds file-store growth.
Production must run exactly one auth-portal replica/writer; neither the users
file nor the limiter JSON provides cross-process transactions. Ingress-layer
distributed limiting and monitoring remain recommended.

Email ownership verification is not currently enforced. This is an explicitly
accepted residual risk for the initial open-signup deployment: an account may
assert an email address it does not own. Do not treat the OIDC `email` claim as
verified until a later verification flow is deployed. Registration creates only
`operator-users` and never entitles the new account to Developer MCP access.

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


## Private Developer MCP connection

The optional Full/Developer MCP edge is a separate OAuth resource from the public
nine-tool connection. Its OAuth request must include the dedicated
`operator:developer` scope and use the Developer MCP resource audience. The
account must also be present in the relay-side `OPERATOR_DEVELOPER_ACCOUNT_IDS`
allowlist; OAuth scope alone never grants the 24-tool relay surface.

Device pairing intentionally continues to request only
`openid operator:read operator:write`. Pairing a computer does not grant
Developer access, and the browser pairing flow never requests
`operator:developer`.

The canonical predefined client is `splcart-operator-chatgpt-developer-v1`.
It uses the same `https://auth.splcart.in` authorization server and normal
Mecord account login as the public connection, but it has a separate client ID,
the Developer MCP resource audience, and the `operator:developer` scope. Keep
the stable ChatGPT redirect, PKCE S256, public-client token authentication
method `none`, and authorization-code plus refresh-token grants exactly as
shown in `authelia-oidc-policy.example.yml`.

Allow `operator:developer` only for this trusted Developer connection. The
relay independently enforces the resolved Mecord account entitlement on every
Developer action/task dispatch.
