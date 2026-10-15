# Mecord website recovery — human-safe product flow

**Status:** initial website review surface implemented. Destructive/irreversible signing is deliberately DISABLED until independent owner authentication is certified.

## Desired user experience

1. Sign in at Mecord and open **Recovery**. A banner displays the number of unresolved original-device actions.
2. See cards in plain language: **Needs review**, **Safely interrupted**, **Outcome unknown**, or **Authority check needed**. Each card explains the consequence; advanced details are collapsed.
3. Actions with independently verified durable proof recover automatically under the pre-dispatch journal lock (vNext PR #355). Such events appear as history; there is no needless user prompt.
4. For uncertain actions, select **Review** and verify the originally intended target/effects, not merely the action ID. The user may postpone.
5. **Permanently stop without replay** requires a one-time step-up with user verification (Windows Hello or a passkey), bound cryptographically to original action + authority + device + case digest + nonce + expiration, with exact intent text shown *before* the OS prompt. On the same-device local agent, a separately certified owner-verifier converts that proof to the signed, case-bound terminal journal fence.
6. The receipt is reconciled only after the journal fence is durable; the hosted relay reconciles and ACKs **only** with the correct delivery/account authority. Uncertain or old completed reads never leak across authority generations.
7. Show a verifiable success receipt with **No action executed**, **Journal interrupted**, and **Relay status** as separate fields. The user can see or export a redacted audit record.

## Shipped in this candidate

- Bounded read-only local API: `GET /v1/control-center/original-recovery` (authenticated).
- Pure redacted projection of original pending receipts + kernel journal.
- A new Recovery section in the existing Control Center with plain-language cards, counts, expandable evidence and keyboard-friendly controls.
- Refuses all website POST adjudication calls with `OWNER_STEP_UP_NOT_CONFIGURED`; the browser cannot turn a normal bearer token into an owner signature.
- Source-generated HTML preserves Content Security Policy (inline scripts/styles nonce), anti-framing, and no client-side credential persistence.

## Pending mandatory security implementation

The owner-verification module must not simply accept `approved: true`, a typed confirmation, a server session, an MCP tool call or a reused recovery token. It requires:

- Authenticator-backed, user-verified WebAuthn/passkey enrollment with trustworthy original-owner account binding, RP ID + exact origin pinning; RP challenge must be fresh, one-time, short-lived, explicitly bound to a case digest and decision. Validate UP/UV bits and signature, key, counter, authenticator user credential and replay ledger.
- Request Origin/Host and same-site checks, CSRF protection, rate limiting, anti-clickjacking, and a separate forbidden remote/MCP route. Never expose a signer or raw DPAPI capability to client JavaScript.
- Verify original Windows device identity, device-bound signing key and original stopped process; never assume Windows PID FILETIME alone proves machine provenance.
- Atomic journal fence before any receipt completion; no headless direct owner signing and no auto-dispatch or cursor skip.
- Physical multi-host Windows Hello/passkey and recovery acceptance; independent security signoff, external signer/ledger/restore witness and staged rollback.

**Hosted vs local:** The current UI is hosted by the authenticated **local** Control Center, not the public Mecord cloud website. A hosted UX needs a separate, authenticated account/session and remote presentation channel, but local WebAuthn step-up must remain trusted on the owner device. A cloud page must not receive or invoke the original device's private signing key.

**Do not deploy to the original incident as the recovery mechanism yet.** The old Windows incident has a separate authority mismatch at pending delivery 3443.
