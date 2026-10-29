# C08 original-device recovery review: local bearer-only GET

Source-level endpoint: `GET /v1/control-center/original-recovery?limit=200`.

- Requires the **direct local-agent bearer token**. A browser-session cookie alone does not provide authority. An authenticated, relay-marked request is rejected rather than treated as original-device evidence.
- Requires both locally configured receipt and canonical action-transition journal stores. Missing or inconsistent stores return a controlled error without exposing filesystem details, secrets or stored payloads.
- Returns only the separately reviewed `buildOriginalRecoveryReviewModel` projection: closed status enums, bounded action references, verified capability label where uniquely matched, static explanation, verified timestamps, and always `canApproveOnWebsite:false`.
- Underlying receipt and journal reads are independent bounded snapshots, **not** a cross-process transaction or recovery proof. Unknown/mismatched histories require independent reconciliation. Neither the GET response nor a status such as `FENCED_AWAITING_RECONCILIATION` authorizes replay or owner signoff.
- Deliberately no POST approval/confirmation route, no signer endpoint, no WebAuthn challenge, no automatic repair, no cursor mutation or journal acknowledgment. Future website display and device-bound step-up require separate review and explicit acceptance.

Synthetic source tests use a disposable local HTTP agent with an authentic on-disk `PREPARED` journal and processing receipt, verify redacted bearer GET, reject unauthorized and relay requests, enforce limits, deny fake adjudication, and check that neither journal/receipt state nor target file changes.

Original physical Windows owner, hosted relay, multi-host concurrent read proof, local browser-session enrollment and signed release acceptance are **NOT_RUN**. This is a read-only coding slice, not C08 completion.
## Control Center browser review (new, observational-only)

The local dashboard's **Recovery** tab now offers a one-click **Review case** and **Recheck recovery evidence** flow. A successful one-time local Control Center browser login can call `GET /v1/control-center/original-recovery/browser?limit=200` from the literal loopback origin. This is a separate narrow GET-only route; the original `/v1/control-center/original-recovery` remains direct-bearer-only. Relay-marked requests, cross-origin requests and bearer-only access to the browser route are denied. A browser cookie does not authorize recovery actions.

Only the existing bounded, HMAC-referenced, redacted `buildOriginalRecoveryReviewModel` is returned. The UI does not export raw action identifiers, authority hashes, resources, payloads, process observations or recovery tokens. Reviewing/rechecking is **read-only**, not owner adjudication, proof of no dispatch, an acknowledgement, clearing a journal, or permission to replay. No POST, retry, delete, automatic recovery or signer route is introduced. Terminal/CLI recovery tooling remains available for separately authorized operator procedures; a future native owner step-up/signed recovery ceremony is required for browser-side final disposition.

The browser review is local-only and ephemeral: closing/signing out the dashboard revokes its in-memory session, while user-visible opaque references are process-local and nontransferable. Physical owner evidence of actual historic action effects is still a separate prerequisite for release acceptance.

## One-click native, device-signed no-replay disposition

The **Resolve safely** control submits only the HMAC-opaque review reference to POST /v1/control-center/original-recovery/browser/resolve. It requires the current local browser session, same-origin CSRF header and literal loopback host; rejects relay-marked, bearer-only, untrusted or malformed requests. Original action IDs, device-signer keys, case digest, operator attestation and recovery tokens never appear in the browser request. The server resolves the opaque reference against fresh protected pending receipts, validates its journal history, checks the existing signed adjudication ledger, exact device generation and definitive original process death. A separate native Windows confirmation asks the owner to attest that this is the original device, the process has stopped and state was not copied. Denial/timeout/headless operation are failures. The existing OperatorPreDispatchAdjudicator then performs a fresh exact-case CAS check and device-signed NO-REPLAY journal fence.

This does **not** execute historical actions, automatically acknowledge relay deliveries, erase receipts or resolve uncertain external effects. The original terminal utility remains available but is no longer required for safely eligible UI no-replay fencing. Independent original owner physical verification, other cases requiring investigation, and production/release acceptance remain separate.

## No-console first sign-in

Control Center also offers **Sign in on this PC**. An unauthenticated browser can POST only to the exact literal localhost /v1/control-center/browser-login/windows, with same-origin mutation headers and bounded JSON. It cannot provide bearer/relay/enterprise authority. A separate visible native Windows Yes/No owner dialog must approve before any in-memory, HttpOnly, SameSite=Strict, idle/absolute-expiring dashboard cookie is issued. Missing Windows desktop, denied/cancelled dialog and headless use fail closed. Only one dialog can be active and attempts have a 15-second local rate limit. The existing one-time console-issued code continues to work as an optional fallback.

This login is **not** itself approval to recover, execute or sign an action. The later **Resolve safely** recovery action still invokes its own separate exact-case native owner attestation and device-signed CAS fence. This login alone never supplies original receipt identities or signer material.


## Finalizing an existing signed no-replay receipt without terminal access

The Recovery tab presents **Finish reconciliation** for original receipts that already have an INTERRUPTED, original never-dispatched journal. The browser submits only the opaque case reference to the existing local, same-origin, cookie-authenticated POST /v1/control-center/original-recovery/browser/resolve. This differs from signing a *new* original PREPARED/DEFERRED recovery.

For existing fences the server:
1. Requires an exact already-existing device-signed adjudication in the fully verified signed ledger. Merely showing INTERRUPTED in the UI does not grant authority.
2. Matches the receipt action digest, authority fingerprint, owner identity and original process binding to the signed decision and terminal journal, including the digest of all transitions before INTERRUPTION. Missing signature, changed identity, dispatched history, mismatched risk or capability fails closed.
3. Requires a visible, default-No native Windows confirmation explicitly stating that the owner is **finishing an existing signed no-replay receipt**, not signing/dispatching a new operation. Denial, disconnected desktop and timeout refuse.
4. After native approval, re-verifies signed ledger signatures and exact terminal journal **inside the receipt cross-process durable lock**, then atomically writes a negative terminal receipt (ACTION_EXECUTION_INTERRUPTED_BEFORE_DISPATCH). No provider execution, retry, relay ACK, deletion or credential exposure.
5. Retains this completed signed-fence receipt indefinitely as a duplicate-action barrier, unlike ordinary seven-day completed receipts. The signed adjudication ledger and INTERRUPTED journal remain intact.

This also applies to **previously signed** destructive no-replay fences. It **does not** add any authorization for an **unsigned** destructive PREPARED action: two historically unsigned destructive cases remain review-only. Unsupported read/missing-journal cases and uncertain/dispatched effects also remain blocked.

Owner physical confirmation on original protected records has **not** been performed by CI. Tests use disposable Windows state and test signing identity only. Release acceptance, hosted/cross-host reconciliation and independently verified original effects remain separate gates.
