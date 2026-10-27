# C08 original-device recovery review: local bearer-only GET

Source-level endpoint: `GET /v1/control-center/original-recovery?limit=200`.

- Requires the **direct local-agent bearer token**. A browser-session cookie alone does not provide authority. An authenticated, relay-marked request is rejected rather than treated as original-device evidence.
- Requires both locally configured receipt and canonical action-transition journal stores. Missing or inconsistent stores return a controlled error without exposing filesystem details, secrets or stored payloads.
- Returns only the separately reviewed `buildOriginalRecoveryReviewModel` projection: closed status enums, bounded action references, verified capability label where uniquely matched, static explanation, verified timestamps, and always `canApproveOnWebsite:false`.
- Underlying receipt and journal reads are independent bounded snapshots, **not** a cross-process transaction or recovery proof. Unknown/mismatched histories require independent reconciliation. Neither the GET response nor a status such as `FENCED_AWAITING_RECONCILIATION` authorizes replay or owner signoff.
- Deliberately no POST approval/confirmation route, no signer endpoint, no WebAuthn challenge, no automatic repair, no cursor mutation or journal acknowledgment. Future website display and device-bound step-up require separate review and explicit acceptance.

Synthetic source tests use a disposable local HTTP agent with an authentic on-disk `PREPARED` journal and processing receipt, verify redacted bearer GET, reject unauthorized and relay requests, enforce limits, deny fake adjudication, and check that neither journal/receipt state nor target file changes.

Original physical Windows owner, hosted relay, multi-host concurrent read proof, local browser-session enrollment and signed release acceptance are **NOT_RUN**. This is a read-only coding slice, not C08 completion.