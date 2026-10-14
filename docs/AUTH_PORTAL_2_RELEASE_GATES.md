# Mecord Connect — Account Portal 2.0 release gates

Status: **implementation in draft PR #343; production NOT CERTIFIED**  
Date: 2026-10-14  
Release scope: `auth.splcart.in` plus the narrow device-management relay/public-edge routes  
Primary objective: provide polished account, device management, pairing, logout and switch-account experiences without changing device trust and without interfering with ongoing Operator relay hardening.

## Product contract

1. **Sign in / registration:** Preserve Authelia-first-factor and PKCE/OIDC flows. Keep existing account signup mode controls, rate limiting, quotas, and email/username uniqueness. No password information in portal server logs. No new registration code requirement.
2. **Account dashboard:** A responsive `/account` view with device name, device ID, pairing date, empty state, refreshing, error handling and release confirmation. A paired device must never be labeled "online" without verified live relay presence.
3. **Pair computer:** Retain 8-character one-time pairing codes, short expiry, and explicit user authorization. Owner transfer is **never automatic**. Explain how to release a device from its old account first.
4. **Logout / Switch account:** Terminate the short-lived management session *and* the Authelia browser session; never silently unpair devices or revoke unrelated ChatGPT tokens. Switching must not reuse a previous account's management session.
5. **Release device:** Only the authenticated current owner can list or release its device. Removal must revoke routed authority, existing device sessions and delivery/results per current relay release hook. Require separate confirmation and CSRF before calling the server.

## Architecture / trust boundaries

| Layer | Browser receives | Authority held |
| --- | --- | --- |
| Authelia sign-in / OIDC consent | Existing login UI and authorization flow | Authelia authenticates a principal |
| Auth portal BFF | HTML, opaque HttpOnly Secure cookie and CSRF token | Short-lived OAuth token in process memory, bound PKCE flow and CSRF |
| Public MCP edge | No browser-facing bearer token | Verifies OAuth issuer/subject/scopes and rate limits |
| Loopback relay control | Nothing | Accepts authenticated verified principal forwarded by public edge; uses internal bearer token |
| AccountDeviceRegistry | Only the current account's sanitized device data | Sole binding/removal authority; active owner exclusivity |
| Device runtime | Existing persistent cryptographic identity | Local approval and file-root boundaries remain unchanged |

Account dashboard management access is short-lived (at most 10 minutes or token expiry). No OAuth bearer token may enter HTML, JavaScript, URL, response JSON, LocalStorage, sessionStorage or logs. Logout cannot be implemented by just hiding buttons.

## Routes

- `GET /signin`, `GET /signup`: existing login and account creation view.
- `GET /pair`, `POST /pair/start`, `GET /pair/callback`: existing pairing protocol with stronger browser-binding for management flows.
- `GET /account/start`: fresh PKCE and browser-bound OAuth state, constrained by rate limit.
- `GET /account`: protected dashboard; no sensitive account response cached.
- `GET /account/api/session`: session presence and per-session CSRF proof.
- `GET /account/api/devices`: bounded device inventory; only own active devices.
- `POST /account/api/remove`: same-origin, CSRF-protected removal action requiring explicit device ID.
- `POST /account/logout`: clears portal management cookie, in-memory token and session; browser also completes Authelia logout.
- `GET /pair/api/devices`, `POST /pair/api/devices/remove`: OAuth bearer-authenticated edge bridge.
- `POST /v1/account/devices`, `POST /v1/account/devices/remove`: internal-only relay account authority bridge.

**No new unauthenticated path to the internal relay is permitted.** There must be no browser-selectable account ID or unsafe cross-account transfer action.

## Functional acceptance matrix

- [ ] Existing account signup still succeeds in intended open-signup mode without invitation.
- [ ] Login handles incorrect password, restart, expired OIDC state, delayed return and existing session.
- [ ] PKCE account management callback requires *both* a valid state and same initiating browser cookie; reject forged callbacks.
- [ ] Account A lists only A's devices; account B lists only B's devices.
- [ ] Account B cannot revoke A's device by guessing an ID. Repeated unauthorized requests remain denied.
- [ ] Device identity/fingerprint mismatch is rejected by existing enrollment gates.
- [ ] Removing a device invalidates live routing, device session and retained results, and audit records show the change.
- [ ] Signing out of Authelia and management BFF prevents the old account dashboard from being reused.
- [ ] Switching from A to B does not display A's devices, even with a stale tab/cookie.
- [ ] Pairing code expiry, reuse and cross-account conflict give safe, actionable feedback.
- [ ] 32-active/128-historical device quotas remain enforced as before.
- [ ] Dashboard works on desktop and mobile sizes; focus-visible, keyboard, screen reader live/error states and confirmations tested.
- [ ] Device inventory does not falsely claim to be an online status monitor.
- [ ] Secrets/tokens/PII do not appear in browser source, logs, traces or errors.
- [ ] Static container copy includes account-dashboard.mjs and all reverse-proxy path rules are deployed together.
- [ ] Previously paired devices and ChatGPT MCP connections continue functioning during a UI-only login/logout operation.

## CI and isolation gates

- [ ] Auth portal signup integration on Windows, Linux, macOS passes on the exact final head SHA.
- [ ] `node --experimental-strip-types --test test/device-pairing-web.test.ts test/auth-portal-deployment.test.ts` passes.
- [ ] `node --experimental-strip-types --test deploy/auth-portal/test/open-signup-runtime.test.ts` passes.
- [ ] `node --experimental-strip-types --test apps/relay-server/test/control-service.test.ts` passes.
- [ ] The MCP server TypeScript build passes (no nullable public-edge configuration errors).
- [ ] Security red-team and relay-authority tests pass; failures unrelated to PR are documented before promotion.
- [ ] Existing active relay hardening and auth registration branches do not lose commits or conflict with this integration.
- [ ] Review diff for auth privilege escalations, CSRF, open redirects, host/header validation and retained tokens.
- [ ] Verify no changes to legacy device identities or agent-owned local files.

## Coordinated production deployment / rollback

**Do not deploy PR #343 merely because the UI workflow is green.** First sync with the agents/PRs already modifying relay P0 and auth signup, and record the combined commit SHA.

1. Capture current production image digests, source commit, current ingress proxy configuration (auth and operator), Authelia OIDC client configuration, health baselines and recoverable backups of relay account/device metadata. Do not export tokens into logs or tickets.
2. Prepare immutable, reproducible builds and an idempotent rollback. Rehearse reverting all updated services/ingress rules to the prior digests/configuration.
3. Stage and verify matched relay control + public-edge binaries; check normal `/mcp`, `/pair/api/claim`, internal relay health and strict OAuth authorization.
4. Stage auth-portal image + auth reverse proxy route changes. Verify all `/account/*`, `/signin`, `/signup`, `/pair` and Authelia machine API paths. Reject all unexpected browser routes.
5. Apply one coordinated promotion of the verified image/configuration set, respecting service compatibility and health checks; keep rollback on hand.
6. Test a fresh admin/account A and standard account B: signup/login, dashboard, logout, switch, pair, release, re-pair. Use intentionally test-only devices for destructive release scenarios, not production laptops.
7. Test two physical Windows laptops simultaneously **only after** account mappings and consent are verified; confirm no `DEVICE_ACCOUNT_CONFLICT`, no cross-account device leak and no side-effect on other installed agent versions.
8. Observe error rates, device enrollment latency, 401/403/409 patterns, API availability and healthy long-running relay sessions. Only mark released if all contractual gates pass.
9. If authentication, authorization or relay regress, atomically restore prior edge/portal/proxy versions and verify old `/mcp`, login and pairing behavior.

## Blockers / signoff

- No production deployment, merge, or device reset is authorized solely by this checklist.
- Signoff requires the **exact final commit**, green relevant checks, live OAuth/Authelia verification, device removal/re-enrollment proof, both physical laptop connection proof, and rollback evidence.
- Never address `DEVICE_ACCOUNT_CONFLICT` by clearing `C:\Users\ASUS\.operator` or by assigning a device to multiple active owners.

Last updated: draft implementation pending CI and live end-to-end verification.
