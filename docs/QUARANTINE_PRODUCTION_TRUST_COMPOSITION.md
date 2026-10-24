# Quarantine review: independently administered production trust composition

The live local-agent entrypoint now calls `configureQuarantineProduction(stateDir)` and **does not create a reviewable adjudicator** unless every trust setting is configured. No default signer, local ledger anchor, hardcoded reviewer, test key, or fallback service is permitted.

## Required independently provisioned values

| Environment variable | Meaning |
| --- | --- |
| `OPERATOR_QUARANTINE_ENABLE=1` | Explicit opt-in, never inferred from partial variables |
| `OPERATOR_QUARANTINE_REVIEWER_URL` | HTTPS *independently operated* human reviewer service base URL ending in /; dedicated identity/permission issuer |
| `OPERATOR_QUARANTINE_ANCHOR_URL` | Separate-host HTTPS *independently operated* high-water CAS service base URL; must be outside runtime restore/backup/administrative control |
| `OPERATOR_QUARANTINE_PROVIDER_PUBKEY_FILE` | Absolute filesystem path to pinned independent provider Ed25519 **public** verification key (PEM) |
| `OPERATOR_QUARANTINE_LEDGER_SECRET_FILE` | Absolute, private, independent 32–256 byte secret file for chained on-device audit MAC |
| `OPERATOR_QUARANTINE_REVIEWER_SERVICE_KEY_FILE` | Absolute private reviewer-service credential (not user session or agent bearer) |
| `OPERATOR_QUARANTINE_ANCHOR_SERVICE_KEY_FILE` | Separate absolute private anchor-service credential |

These are **configuration names, not real credentials**. Files must be outside the restorable `.operator` state root. On POSIX their modes must deny group/world access. Never check secrets into Git, put them under a web server root or request them in ChatGPT.

The app refuses to start if *any* quarantine trust variable is present but explicit opt-in/completeness, TLS-only unique service hosts, strong keys and remote genesis verification are missing. With no variables, the product starts as before but review remains unavailable (HTTP 503). No production reviewer/anchor is provisioned by this code.

## Contract: reviewer service

A trusted HTTPS server handles `POST <reviewer-base>/authorize` with **separate application-to-service** `Authorization: Bearer <reviewer-service-credential>`.

- For `kind:'request-bound-review'`: body contains `scope={programId,targetKey,returnedMissionId}` and the original human-provided `session` from `x-quarantine-review-session`. The reviewer service **must validate** the fresh independently signed human session, current revocation, principal, exact program/target/mission scope, admin permission and freshness; never trust a display name or `operatorId` request field.
- For `kind:'provider-claim-authorization'`: body contains `operatorId` and the **provider-signed claim**, including program, target, intended/exact returned IDs, process, device, session, authority generation and origin digest. The external reviewer checks fresh operator permissions and revoked authority *again* at the adjudicator's effect boundary.
Only an HTTPS 200 JSON response with `authorized: true` and a validated `operatorId` is accepted. The reviewer must also return the **exact `scope`** in request-bound review responses, or a **SHA-256 `claimDigest`** matching the exact serialized signed-provider claim in provider-claim authorization responses. Missing/mismatched attestation, negative authorization and all network errors deny review.
- Maintain independent immutable authorization receipts and short-lived credentials on this external service; local process metadata is not proof of production identity.

## Contract: independent CAS high-water anchor

`GET <anchor-base>/position` → `{ "position": { "count": 0, "headMac": "000...000" } }`.

`POST <anchor-base>/compare-and-advance` with `{ "expected": {count,headMac}, "next": {count,headMac} }` must perform an **atomic, authorized** compare-and-swap within an independently administered database and return `{ "ok": true, "position": next }` **only after durable commit**. Every failed/stale expectation must return an error (e.g., HTTP 409). The existing `PostgresQuarantineLedgerAnchor` supplies real SQL CAS semantics; deployment must place its database and backup authority outside the original operator's failure/restore domain. This bridge is an HTTPS transport, **not proof that the remote service is backed by PostgreSQL**. Independent deployment and witnessed failover testing are required.

## Security boundaries

- Normal agent bearer and separate `OPERATOR_RECOVERY_TOKEN` remain mandatory HTTP checks. Relay-proxied review is forbidden.
- Human reviewer session validation is request-specific; the reviewer client never trusts an `operatorId` supplied by a caller.
- Provider claims are checked using the pinned Ed25519 provider *public key* and exact original provenance; no local impersonation signer is created.
- Verified-owned classification **does not cancel** the returned child; it remains quarantined until an independently authorized, provider-atomic cancellation/terminal receipt exists.
- A mismatch, missing config, network outage, invalid response, anchor rollback, or changed reviewer identity denies adjudication.
- Never treat a transient locally hosted mock reviewer/anchor as satisfying production release gates.

## Remaining operator-owned acceptance

Independent external deployment, genuine non-demo Ed25519 provider signer and reviewer identity provider, protected secret provisioning, immutable remote audit and CAS anchor, active/expired/revoked cross-restart and crash tests, and signed production provider receipts **cannot be completed just by compiling this adapter**. #151 remains OPEN until real end-to-end staging/production evidence demonstrates these independent trust domains.
