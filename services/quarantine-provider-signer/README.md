# Independent provider-origin signer: operational runbook

**Status: code and tests, NOT externally deployed or production certified.** This component addresses only the provider signer part of P0 #151. It does not replace a human reviewer, external CAS/ledger, backup witness, or npm release approval.

## Security design

- Run the signer in a separately administered hosting/account, TLS, key-custody and backup domain. Another container or DNS name on the same Mecord VPS is NOT independent.
- Mecord's laptop, relay, VPS and source repository hold only the signer PUBLIC key. Its Ed25519 private key must remain under the external administrator's custody. Never commit private keys, tokens, production profiles or signed identity sessions.
- Requests to POST /v1/provider-claims/sign can contain ONLY programId, targetKey and returnedMissionId. No classification, provider evidence, approver identity or prewritten signature is accepted from the caller.
- The external signer queries the separate authoritative provider-origin HTTPS API on EACH request, checks the independent upstream provider Ed25519 signature, issuer, creation intent, deterministic expected ID, matched scope, process/device/session and authority generation. The observation may be at most 30 seconds old; its lifetime at most 60 seconds.
- The trusted provider-origin API must itself verify true durable creation provenance and current revocation. A mock, demo receipt, stale cached result or arbitrary signature oracle is not evidence. No provider-side signed source is currently provisioned by this repository.
- Signer claim output is {claim,signature}; signature is Ed25519 base64url over UTF-8 JSON.stringify(claim). The output schema matches the OrganizationQuarantineAdjudicator provider-origin verification.
- verified-owned does NOT grant cancellation authority. Human reviewer and external high-water CAS anchor remain separate controls.
- Origin outage, key mismatch, stale receipt, revoked generation, wrong origin issuer, wrong scope or TLS/authorization failure must all fail closed.

## Network protocol

GET /health over HTTPS and mandatory mTLS returns readiness and public-key fingerprint. This is not an origin attestation.

POST /v1/provider-claims/sign over HTTPS/mTLS additionally requires a distinct Bearer request token. JSON body consists of exactly three identity fields: programId (UUID), targetKey (bounded label), returnedMissionId (UUID). Response is a signed provider claim suitable for Mecord.

Read-only provider evidence is fetched from GET {SIGNER_ORIGIN_API_URL}/v1/creation-origin with matching programId, targetKey and returnedMissionId query parameters. Upstream returns {receipt,signature}, where signature is made using ANOTHER Ed25519 key over JSON.stringify(receipt). The receipt must have fields schemaVersion=1, issuer, intentId, programId, targetKey, expectedMissionId, returnedMissionId, classification, evidenceDigest, providerDeviceId, providerProcessId, providerSessionId, authorityGeneration, observedAt, validUntil. The upstream real provider DB, not the signer, is responsible for authoritative source classification and revocation.

## Deployment configuration — on the separate signer host only

All *_FILE variables are absolute trusted file paths, NOT values to paste into chat. The service currently requires group/world-inaccessible file permissions on POSIX for every referenced material, including certificates and public verification keys. Use narrowly scoped principals and monitor signing decisions.

| Environment variable | Purpose |
| --- | --- |
| SIGNER_TLS_CERT_FILE | HTTPS server certificate |
| SIGNER_TLS_KEY_FILE | server private TLS key |
| SIGNER_CLIENT_CA_FILE | independently administered TLS client CA |
| SIGNER_PRIVATE_KEY_FILE | external Ed25519 claim signer private PEM |
| SIGNER_ORIGIN_PUBKEY_FILE | independent upstream provider Ed25519 public PEM |
| SIGNER_REQUEST_TOKEN_FILE | dedicated signer API bearer credential |
| SIGNER_ORIGIN_TOKEN_FILE | separate read-only origin API bearer credential |
| SIGNER_ORIGIN_API_URL | independently operated HTTPS provider evidence endpoint |
| SIGNER_ORIGIN_ISSUER | pinned exact provider-origin issuer |
| SIGNER_PORT | optional port, default 8443 |
| SIGNER_BIND_HOST | optional interface, default 127.0.0.1 |

Start with: node services/quarantine-provider-signer/server.mjs

The signer public key belongs in OPERATOR_QUARANTINE_PROVIDER_PUBKEY_FILE on Mecord, and the remaining independently controlled REVIEWER_URL, ANCHOR_URL and ledger credentials follow docs/QUARANTINE_PRODUCTION_TRUST_COMPOSITION.md.

## Required real deployment acceptance

1. Verify distinct administrators, domain ownership, key custody, origin-provider state, backups and on-host TLS+mTLS. Do not co-host with the original relay.
2. Test live provider creation, foreign ID, missing ID, revoked generation/session, wrong process/device and signing key rotation. Every unproven result must deny signing.
3. Prove cross-domain signing, separately authenticated human reviewer and atomic external CAS/ledger anchor with durable committed receipts, including restart and restore.
4. Certify old-key revocation, stolen client credential denial, provider partition, site failure and off-domain backup/rollback. Never let a restored snapshot resurrect revoked creation authority.
5. Record independent auditor evidence, publicly checkable signer SPKI fingerprint and signed claim digest, without disclosing private material. Keep issue #151 and release state on HOLD until these conditions are proven and owner separately authorizes deployment.

## Local checks

node --test services/quarantine-provider-signer/test/provider-origin-signer.test.mjs

This tests signatures, caller injection, stale/origin-mismatch handling and fail-closed paths. Synthetic tests alone are NOT external signer certification.
