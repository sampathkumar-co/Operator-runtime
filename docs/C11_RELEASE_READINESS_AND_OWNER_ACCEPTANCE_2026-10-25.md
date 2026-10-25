# C11: Wave 0–4 source-readiness checkpoint and owner release authorization

**Status (25 October 2026): SOURCE IMPLEMENTATION ONLY; RELEASE NOT AUTHORIZED.**

This adds controls; it is not an assertion that any model, physical Windows machine,
Chrome/Edge/UIA, original receipt recovery, hosted relay, signing, canary or user task
has passed certification.

## 1. Automated read-only source checkpoint

`node scripts/wave4-source-readiness.mjs` requires a read-only `GITHUB_TOKEN`
and `GITHUB_REPOSITORY`. It checks the **actual checkout HEAD**, issue #374
and the 12 issue bodies #375–#386. Exactly 134 unique C00–C11 task IDs and
the 5 canonical wave partitions are mandatory. The generated SHA-256-bound
report records each unchecked task and explicitly sets:

- `publicationAllowed: false`
- `releaseAuthorization: NOT_GRANTED`
- all independent real-world gates: `NOT_AUTHENTICATED_IN_THIS_SOURCE_CHECK`

The dedicated GitHub CI retains the report. This proves source-checklist
accounting only, not the assertions made inside checkboxes. A green report must
not become a release approval.

## 2. Mandatory independent evidence and source-pinned owner identity

The Windows production release workflow is **additionally blocked before
certificate material is loaded** unless all 134 items are accepted and there
is a separately owner-signed, exact-SHA attestation for nine gates:

1. Independently scored Lane A/B/C real-model tests
2. Fifty real, held-out user workflows
3. Supplementary official 125-task MiniWoB benchmark
4. Original Windows Chrome/Edge/UIA execution
5. Original two-host receipt/relay recovery with preserved history
6. Independent policy, approval, security and no-replay evidence
7. Reproducible signed packages, source attestation and rollback
8. Opt-in owner-approved canary and Stop behavior
9. Production telemetry and explicit owner publication authorization

Each attested gate has `status: OWNER_SIGNED_PASS`, an HTTPS `evidenceUri`
and an `evidenceSha256`; these are assertions reviewed by the owner, NOT
proof that source CI independently authenticated the contents at those URLs.
All links must point to genuinely retained immutable evidence rather than
invented runner output.

The detached owner Ed25519 signature covers the exact JSON bytes of:
`{schemaVersion:1, approval:"APPROVE_EXACT_SOURCE_RELEASE", candidateSha,
issuedAtMs, expiresAtMs, gates}`.
The valid signature lifetime is at most 24 hours, and the source SHA must
match the checkout used for Windows signing.

**Signer NOT enrolled:** `certification/wave4-owner-key.json` intentionally
contains `status: NOT_ENROLLED` and `publicKeySpkiSha256: null`. Do not
change those fields until the owner has independently verified the signing
key's identity and opened a separately reviewed, non-secret trust-anchor PR.
The SHA is computed from the DER-encoded Ed25519 SPKI public key, not the
displayed PEM text. The owner keeps the private key offline. Never put it in
GitHub source, logs, issues or chat.

Only after evidence review and identity pinning, provision three values through
the appropriately protected GitHub release environment/secrets mechanism:
`OPERATOR_WAVE4_RELEASE_ATTESTATION_B64` (Base64 of exact JSON bytes),
`OPERATOR_WAVE4_RELEASE_SIGNATURE_B64` (detached Ed25519 signature), and
`OPERATOR_WAVE4_RELEASE_PUBLIC_KEY_PEM` (the matching public key).

A signature verifies the owner's approval of evidence references. It does
not validate evidence content itself. Independent reviewers or authenticated
systems must check each artifact against the claimed digest and real external
outcome before the owner signs. Signing the synthetic test fixture, replacing
a key to force a passing test or checking items without verification is not
acceptable.

## 3. No change to production in this PR

- The published npm `mecord-connect@2.0.6` and original `.operator`
  receipts/relay state are untouched.
- Signing, production deploy and GitHub Release publication are NOT performed.
- CI uses ephemeral test-generated keys to test the signature validator only.
- The source-pinned key is deliberately unenrolled, so an accidental production
  release from the new workflow fails closed.
- Owner 2FA, deployment, rollback and final source-matched physical acceptance
  require later explicit owner action and independent evidence.

If any mandatory gate lacks evidence, keep it **DEFERRED/NOT_CERTIFIED** and
do not close canonical issue #374 or declare a production release complete.
