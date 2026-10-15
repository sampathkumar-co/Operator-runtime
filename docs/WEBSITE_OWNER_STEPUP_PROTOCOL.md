# Website case-bound owner step-up — security implementation candidate

**Release state: INCOMPLETE / DRAFT.** This implements a verifier and local
authenticated server endpoint, NOT a generally available Windows Hello
confirmation feature. The website's visible approval control remains disabled
until the trusted enrollment and UI integration are certified.

## Complete end-to-end intended flow

1. The original owner enrolls a **device-bound** WebAuthn platform credential via
   an **independent trusted bootstrap** (NOT an agent bearer token, MCP call,
   self-attested WebAuthn registration sent over the agent API, or a synced
   cross-device passkey). RP ID and exact HTTP secure-context origin are pinned.
   The trusted enrollment must bind credential ID and public key to the existing
   original device ID and fingerprint.
2. Read-only website presents the exact original action, effect and risk.
   The original Windows owner explicitly attests the old process is stopped and
   the state wasn't copied. The owner chooses **Permanently stop without replay**.
3. The authenticated local server re-inspects original receipt and journal and
   issues a random **single-use 32-byte, 90-second WebAuthn challenge**, pinned to
   the original action ID, current case digest, and existing device identity.
4. The browser uses `navigator.credentials.get` with `userVerification:
   "required"`. The OS provides Windows Hello or a certified device-bound
   authenticator with a non-syncable credential.
5. The server enforces exact Origin, Host and same-site fetch checks; rejects
   relay-marked or missing intent-header traffic. It consumes the challenge
   before verifying WebAuthn `clientDataJSON`, RP ID hash, `webauthn.get` type,
   same origin, cross-origin false, authenticator UP and UV bits, no backup-
   eligible flags, credential ID, ES256 signature, and sign counter when supplied.
   It re-inspects the exact case digest before any local signing request.
6. Only after verification, the existing original-device adjudicator signs its
   case-bound decision and attempts the journal-locked terminal fence. It never
   executes the original provider operation. Web response clearly states
   **receiptReconciled: false**, because relay delivery remains separate.
7. The receipt and hosted delivery are reconciled later using the correct
   original approval/execution authority; the pending 3443 completed read is
   NEVER replayed or ACKed across an authority change.

## Implemented in this draft

- `apps/local-agent/src/original-recovery-webauthn.ts` — strict pure cryptographic
  assertion verifier and bounded single-use challenge store.
- Optional injected `originalRecoveryOwner` in `createLocalAgentServer`.
  The runtime does **not** wire this automatically. It requires an independently
  provisioned original owner credential and existing-device adjudicator.
- Authenticated local `POST /v1/control-center/original-recovery/challenge` and
  `POST /v1/control-center/original-recovery/confirm`, both blocked when no
  trusted owner verifier is configured. No setup or credential enrollment route
  is available to the agent/relay or website.
- Attack tests: forged/wrong signature, origin, RP ID, missing UP/UV,
  backup-eligible passkeys, cross-case verification, expiration, replay, and
  original-device mismatch; server test demonstrates bearer-only cannot sign.
- Existing review website remains read-only unless explicit trusted provisioning
  and a separately approved browser UX integrate the OS prompt.

## Mandatory release blockers

- Independent owner-device credential enrollment and trusted attestation / key
  provisioning. `fmt=none` WebAuthn registration supplied via a bearer API
  cannot bootstrap the original-owner trust root.
- Device-bound credential proofs, user intent transaction display and Windows
  Hello physical acceptance on actual supported browsers and ports. The UI
  still has a disabled button; no claim of one-click live approval.
- Production trusted credential storage with immutable onboarding provenance,
  independently audited recovery-owner authorization and rotation/revocation.
  Authenticate a true human separate from the agent's bearer authority.
- Durable distributed anti-replay / sign-counter CAS; per-process challenge
  invalidation is in place but full external trust infrastructure is not.
- Separate security review, code and dependency checks, credential and original
  state portability tests, and genuine manual multi-host acceptance.
- Public Mecord cloud dashboard still requires independent account binding and
  secure presentation-only RPC; the local verifier must never hand a private
  signing key to the hosted web page.
- Existing protected original device / delivery 3443 remains on HOLD. **Do not
  deploy this draft or resume the relay to force reconciliation.**

This protocol avoids retyping 64-character action digests, but it must not
turn a website session, a remotely driven browser or a generic confirmation
dialog into a forged original-device owner signature.
