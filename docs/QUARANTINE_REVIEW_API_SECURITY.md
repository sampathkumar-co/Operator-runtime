# P0 #151 — quarantined organization identity review API

## Exact local-only review route

`POST /v1/organizations/:programId/quarantines/review`

Required independently:
1. Normal local-agent bearer authentication.
2. A **separate** `x-operator-recovery-token`, configured out of band.
3. A **trusted server-supplied** `quarantineReviewAuthorization({programId,targetKey,returnedMissionId})` callback returning the actual approved `operatorId` after checking the requesting human's scoped identity. Never derive operator identity from request JSON, display name, client-supplied headers, or relay-originated actions.
4. The injected `OrganizationCoordinator` must itself be wired with `OrganizationQuarantineAdjudicator`, pinned independent Ed25519 provider verification key, strong MAC secret, signed origin evidence, appropriate operator permission, and an **external CAS high-water anchor** outside the restored state domain (production `requireExternalAnchor: true`).

Request JSON is exactly the claimed target identity and provider attestation:
```json
{
  "targetKey": "service",
  "returnedMissionId": "00000000-0000-4000-8000-000000000000",
  "providerClaim": {
    "claim": { "schemaVersion": 1 },
    "signature": "actual signed independent provider claim"
  }
}
```
Illustrative shape only; placeholders will be rejected by actual signature/claim validation.

Without independent operator authorization and recovery-token configuration the endpoint returns `503 QUARANTINE_REVIEW_NOT_CONFIGURED`. Without separate secret it returns `401 RECOVERY_UNAUTHORIZED`. A body-supplied `operatorId` returns `400 QUARANTINE_REVIEW_INVALID` and never invokes a reviewer. A trusted reviewer denial returns a non-sensitive `403` and never performs provider adjudication.

A classification of `verified-owned` **does not authorize cancellation** or retire the original compensation. All mutation rights remain restricted by the existing signed provider adjudicator's original-intent, exact-identity, MAC-chain, and external-anchor checks.

## Test result and still-open production gate

On original Sampath Windows, `node --experimental-strip-types --test test/organization-quarantine-api.test.ts test/organization-quarantine-adjudication.test.ts`: 13 pass / 0 fail, including separate recovery-token denial, spoofed operator identity rejection, independently scoped identity, signed attestation and external anchor failure.

**Not production certified:** no independent production provider origin signer, immutable key provisioning, external anchor deployment, authenticated reviewer service, or real terminal provider effect receipt has been supplied for this integration. Keep [#151](https://github.com/sampathkumar-co/Operator-runtime/issues/151) open. Do not attach a demo key, default allow-all callback, or unscoped operator token to make deployment appear complete.
