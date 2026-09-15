# Windows Store local certification â€” 2026-09-14

This record captures the final local unsigned Microsoft Store package audit on branch `codex/chatgpt-publication-security-p0-20260913`. The certified implementation was committed in three bounded steps: `a836b7c` (Store packaging audit), `2fc591b` (Windows path authority and release workflows), and `09db0f3` (security authority and public-edge hardening).

## Clean-checkout integration proof

Before `09db0f3` was committed on the shared branch, its exact 88-file tree was reconstructed on a fresh worktree based on `2fc591b` with no scratch helpers or generated artifacts copied in. Using the certified Node v22.23.2 runtime and a freshly built Windows path-lease helper, that clean tree passed MCP 51/51, relay 29/29, red-team 6/6, and the full Windows root suite at 302 total / 286 passed / 0 failed / 16 expected environment skips. The Git index tree transferred to the shared branch matched that certified clean-worktree tree byte-for-byte before commit.

## Historical local candidate artifact (pre-P1)

- File: `artifacts/windows-release-audit-20260914/Operator-1.0.0.0-x64.msix`
- SHA-256: `74dd941795487e16b12d0e359f5703bafdc55ec40250f5f6861eccaeac1fcc38`
- Unpacked file count: 2701
- Identity: `SPLCART.SplcartOperator`
- Publisher: `CN=6F726FAE-9AD9-4643-A991-7E86CBD7C967`
- Version / architecture: `1.0.0.0` / `x64`
- Display / publisher display names: `SPLCART Operator` / `SPLCART`
- Restricted capability: `runFullTrust`

This local MSIX predates the final P1 review fixes below and is retained as historical packaging evidence only; it is not claimed to be byte-identical to the final P1-hardened tree.

## Exact-head CI Store artifact after P1 hardening

- PR head: `e62deda6fbbe197249e5cdf8a3afdd926b49eb76`
- CI run: `#488`
- Artifact: `splcart-operator-store-submission-msix`
- Artifact size: `39,452,129` bytes
- GitHub Actions artifact digest: `sha256:d7dfc11e5e326de6f43930b871498916fe12b7d2963cf30637dff7a0a86bc5b9`
- The Windows package job built, unpacked, validated, and uploaded this Store submission artifact from the exact P1-hardened PR head.

## Artifact proof

Launcher, certified Node v22.23.2, UIA and DPAPI hashes match the independently verified build inputs. The packaged path-lease helper is byte-identical to the helper freshly compiled during this exact package run. Launcher, DPAPI and path-lease self-tests pass, UIA health passes, and the unpacked package's MCP server starts with the bundled Node/dependency tree and returns healthy on its loopback `/health` endpoint.

The package contains zero first-party test/fixture files, zero forbidden secret/key filenames, and zero dependency `test`, `tests`, `fixtures`, `benchmark`, `benchmarks`, or `.github` directories after production pruning. `npm ls --omit=dev --depth=0` is clean and the MCP Inspector dev dependency is absent.
## Green gates

- Store/release-focused contract: 30/30 passed.
- MCP TypeScript + E2E: 51/51 passed.
- Red-team: 6/6 passed.
- Relay: 29/29 passed.
- Full root Windows suite with the real path-lease helper: 302 tests, 286 passed, 0 failed, 16 skipped.
- All five Windows junction/path-authority cases executed and passed (`281` through `285`).
- Root syntax/import check and `git diff --check`: green.

The 16 root-suite skips are environment-gated symlink cases where Windows denied symlink creation (`EPERM`); they are not failures and no Windows junction-race case was skipped.

## Post-certification release-line consistency

A final pre-merge consistency sweep found that the public npm bootstrap still declared version `0.1.0` and accepted Windows releases as old as `0.1.0.0`, while the certified Store launch line is `1.0.0.0`. The bootstrap package is now `1.0.0`, its minimum trusted Windows release is `1.0.0.0`, its user agent reports the same CLI version, and Windows signing smoke uses `1.0.0.0`. Focused release/bootstrap tests passed 25/25, the npm tarball dry-run reported `operator-runtime-cli@1.0.0`, the syntax/import checker passed, and the full Windows root suite remained 302 total / 286 passed / 0 failed / 16 expected environment skips with all five junction cases executed.

A second pre-merge release-path sweep found that the production signing workflow could previously derive the MSIX manifest Publisher from whichever certificate was supplied. That could produce a validly signed package with a publisher different from the Partner Center identity. Production release now pins `STORE_PUBLISHER=CN=6F726FAE-9AD9-4643-A991-7E86CBD7C967`, rejects any production certificate whose subject differs, and verifies signed metadata, App Installer metadata, trusted-signer matching, and bootstrap smoke against that same Partner Center publisher. The ephemeral CI signing smoke remains intentionally certificate-flexible and is not used as Store identity authority. The Store contract test passed 5/5 and the full Windows root suite again remained 302 total / 286 passed / 0 failed / 16 expected environment skips.

## Remaining external gates

This is local unsigned-package certification, not final production approval. For the Microsoft Store lane, the remaining external gates are Partner Center submission/certification, production OAuth/public MCP deployment, live ChatGPT certification, and real-user/reviewer evidence; the Store re-signs accepted MSIX/AppX packages, so a publisher-owned CA-trusted PFX is not a Store submission prerequisite. The separate direct/npx lane remains blocked until a trusted signing strategy compatible with its package identity is selected, its signer is pinned, an RFC 3161 timestamped package is produced, and the signed release assets are published. Microsoft documents the Store signing distinction in its MSIX package requirements and Windows distribution-path guidance: https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/app-package-requirements and https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/choose-distribution-path. The legacy .NET Framework compiler used for the path-lease helper does not provide deterministic output across separate compilations, so cross-build reproducibility is not claimed for that helper; exact-build package/source hash equality is verified.
## Post-review P1 hardening

Two pre-merge review findings were reproduced and fixed before release. Unauthenticated enrollment completion now verifies pairing into a short-lived provisional identity and does not consume permanent device-registry capacity until authenticated account claim; a 140-handshake adversarial regression passes without exhausting the permanent device registry or active-challenge budget.

A fresh Codex review of the then-final PR head found that receipt acknowledgement still crossed the wrong boundary: MCP could acknowledge before its upstream response was delivered, result consumption and idempotency release were separate durable writes, and retry recovery still attempted online routing before consulting completed work. The receipt endpoint was therefore removed instead of patched again.

Relay result recovery is now invocation-replay based. A subsequent final-head Codex review found two more P1 edges in that design: public invocation identity was scoped only to OAuth client plus JSON-RPC request ID, allowing a later MCP session to reuse an old request counter, and delivery-created retention could expire replay authority before a late-completed result expired. Both were reproduced and fixed.

The MCP JSON-RPC request ID is now scoped by both OAuth client and validated MCP session identity before hashing into `taskId`, so retries inside one session are stable while a later session with the same request counter is distinct. Completed result records now atomically store the server-generated idempotency key alongside the result, and completed replay lookup occurs before delivery recovery or online routing; replay authority therefore has exactly the same `recordedAt + retention` lifecycle as the replayable result. Natural expiry of a still-running idempotent delivery scrubs payload and account authority but retains only its bounded 64-byte invocation tombstone, preventing silent redispatch. A late authenticated result can still bind to that exact expired delivery and become replayable; if no result ever arrives, retry fails closed with `RELAY_EXECUTION_EXPIRED_UNCERTAIN` instead of repeating the side effect. Explicit device/account purge still removes replay authority.

Final local certification on that recovery-hardened tree: relay package 33/33, MCP TypeScript/E2E 52/52, red-team 6/6, root Windows suite 305 total / 289 passed / 0 failed / 16 expected environment skips, all five real junction tests executed, path-lease self-test green, syntax/import checker green, and `git diff --check` green.

## Final P2 recovery and authority fencing

A fresh Codex review of PR head `aa48eb2862be3cb796518baaaeb0211d5b724fd8` found two additional recovery edges. First, the relay server could authenticate an expired-history cursor while the device still had a durable local `processing` record, but the client rejected that welcome before its local outbox recovery callback could resubmit the already-executed result. Second, account/device release could race an in-flight result request after session verification and delivery lookup, allowing the old request to recreate replayable result state after the release purge.

Expired processing now has a dedicated recovery path: an authenticated `expiredThroughSeq` may reconcile a matching durable `processing` record only through `onExpiredRecovery`, which resubmits the exact locally persisted outbox result and never re-executes the expired delivery payload. The client advances its durable cursor only after that recovery returns `ack`, after which fresh deliveries may resume normally.

Replayable relay state is also fenced to the immutable account/device authority generation that created the delivery. Natural expiry copies only `{accountId, deviceId, generation}` into a minimal `replayAuthority` tombstone while scrubbing live authority and payload. Result persistence verifies that generation immediately before and after the durable result write; a concurrent authority release causes the exact stale record to be removed. Completed-result replay and in-request result delivery independently revalidate the stored generation against the current active membership before exposing the ActionResult. Explicit device/account purge removes both delivery replay authority and the entire result stream.

Adversarial regressions now cover expired local processing recovery without payload replay, stale-generation completed replay rejection, concurrent account/device release during result persistence, late authenticated result recovery, full result-retention replay, and payload-free expired tombstones. Final local certification on this exact P2-hardened tree: relay package 35/35, MCP TypeScript/E2E 52/52, red-team 6/6, root Windows suite 306 total / 290 passed / 0 failed / 16 expected environment skips, all five real junction tests executed, path-lease self-test green, syntax/import checker green, and `git diff --check` green.
## Final P2 durable revocation ordering

The exact-head Codex review of `cb5a4866646e2725be3892a2ee76945d2d6669f1` found one remaining release race: `removeDevice()` and `disableAccount()` invoked purge hooks before the changed account/device authority was durably written. A result POST could therefore write after the purge yet still pass both generation checks while the release hook was in flight.

Account/device release now commits the disabled/removed authority state before any purge hook runs, while keeping the registry mutation queue held until cleanup completes. Removed memberships carry a bounded `releasePendingReason` only until cleanup succeeds. If cleanup fails or the process crashes after revocation, authority remains revoked, rebinding is blocked, and `recoverReleases()` replays the idempotent cleanup on startup or retry before clearing the marker. Account erasure retains its existing durable phase journal, whose `erasing` authority tombstone already precedes destructive cleanup.

The adversarial result-service regression now pauses a release hook after delivery/result/session purge, writes the old in-flight result during that exact window, and proves the request is rejected with `RELAY_RESULT_AUTHORITY_REVOKED` and leaves no replayable residue. A separate registry regression proves the release hook observes authority already revoked on disk and that a simulated cleanup crash is recoverable from the durable pending marker.

Final local certification on this revocation-ordered tree: relay package 35/35, MCP TypeScript/E2E 52/52, red-team 6/6, root Windows suite 307 total / 291 passed / 0 failed / 16 expected environment skips, all five real junction tests executed, path-lease self-test green, syntax/import checker green, and `git diff --check` green.

## Final authority-lease and erasure cleanup fencing

The exact-head Codex review of `a681cc1e2511b28dc84cf3c68ee6dc2814883793` found two remaining crash/concurrency edges. First, account erasure could discard a previously removed membership whose `releasePendingReason` still represented unfinished global cleanup. Second, a result write or delivery enqueue that had already passed an authority check could be queued behind a purge store mutation, then commit after the purge hook returned and the cleanup marker was cleared.

Account erasure now drains every pending device-release cleanup for the account while holding the registry mutation queue before creating or resuming its erasure journal. Startup erasure recovery also drains pending releases first, so an erasure can never delete the durable marker that makes unfinished device cleanup recoverable.

Authority-bound relay storage now follows one lock order: account authority lease first, then relay result/delivery store mutation. `withActiveAuthorityLease()` validates the exact account, device, authority generation, active account state, active membership, and active cryptographic device while holding the account registry queue for the entire durable store mutation. Release/disable/erasure therefore either waits for an already-authorized write to commit and then purges it, or commits revocation first and the waiting write fails before entering the store. Result and dispatch entry points map a revoked lease to their existing public relay authority errors.

Adversarial regressions cover both directions. The result test pauses an in-flight durable result write, starts device removal, proves purge cannot begin until the write completes, and then proves the purge removes the result and replay key. The relay-hub test pauses an in-flight durable enqueue, starts removal, proves purge cannot begin until enqueue completes, accepts the expected post-enqueue `RELAY_AUTHORITY_CHANGED` from pumping the now-revoked route, and proves only a scrubbed expired tombstone remains with no authority, payload, or idempotency replay key. A separate registry regression injects failed cleanup and proves `eraseAccount()` cannot discard that pending marker.

Final local certification on this authority-lease tree: relay package **36/36**, MCP TypeScript/E2E **52/52**, red-team **6/6**, root Windows suite **309 total / 293 passed / 0 failed / 16 expected environment skips**, all five real junction tests executed, path-lease self-test green, strict TypeScript check green, syntax/import checker green, and `git diff --check` green.


## Public reviewer-page launch-readiness hardening

A final submission-readiness sweep found that the review package advertised `https://operator.splcart.in/privacy`, `/terms`, and `/support`, while the canonical Caddy ingress routed only MCP/OAuth and device endpoints and otherwise returned `404`. The documented reviewer/legal URLs would therefore have failed on the recommended production topology even after DNS/TLS were provisioned.

The public edge now exposes exactly those three read-only paths and no general file-serving surface. Their content is sourced from the repository-reviewed `PRIVACY.md`, `TERMS.md`, and `SUPPORT.md` files bundled into the hardened container. The renderer HTML-escapes the complete source before embedding it in a bounded styled document, so repository Markdown/raw HTML cannot create an executable HTML/script surface. The three immutable pages are pre-rendered once during process startup, eliminating synchronous filesystem reads from the unauthenticated request hot path. Responses additionally carry a restrictive CSP, same-origin resource policy, frame denial, and `nosniff`. The routes are enabled only in public-edge mode and use the same Host/Origin validation as OAuth discovery and MCP ingress. Caddy explicitly proxies only `/privacy`, `/terms`, and `/support` to the MCP edge.

Local certification for this launch-readiness change: relay **36/36**, red-team **6/6**, MCP strict TypeScript check green, deployment-invariant suite **5/5**, MCP E2E **52/52** including all three page responses, expected HTML content, raw-script exclusion, and wrong Host/Origin rejection, full Windows root suite **309 total / 293 passed / 0 failed / 16 expected environment skips** with all five real junction tests executed, path-lease self-test green, syntax/import checker green, and `git diff --check` green. Local Docker image execution was not available because the Docker Desktop Linux engine was not running on the certification host; clean-runner public-edge container CI remains the authoritative container-build gate for the published exact head. This code change does not make the deployment-specific legal text final: verified publisher/contact identity, governing-law/jurisdiction disclosures, actual hosting regions/providers, concrete retention, subprocessors, and a private security-reporting/support path still require production finalization before submission.


### Reviewer website root follow-up

Final Codex review of the public-page pass found that the plugin manifest declares `https://operator.splcart.in` as its reviewer-facing website while canonical ingress still returned `404` for `/`. The edge now exposes exact `/` alongside `/privacy`, `/terms`, and `/support`; the root is a static script-free SPLCART Operator landing page linking only to those three reviewed pages. It uses the same Host/Origin validation, startup-only rendering, CSP/frame/nosniff headers, and exact Caddy matcher. Unknown paths remain `404`.

Local certification on the P1-fixed root-route tree: relay **36/36**, MCP TypeScript/E2E **52/52**, red-team **6/6**, deployment invariants **5/5**, root Windows suite **309 total / 293 passed / 0 failed / 16 expected environment skips**, all five real junction tests executed, path-lease self-test green, syntax/import checker green, and `git diff --check` green.


## Production notice injection hardening

Exact-head Codex review of the reviewer-page implementation found a release-blocking disclosure issue: the canonical image was publishing repository-root privacy, terms, and support drafts verbatim even though those files explicitly state that deployment-specific publisher/contact, hosting, retention, subprocessor, jurisdiction and private security-reporting details are unfinished. The production image no longer copies those drafts. Public-edge startup now requires separately reviewed deployment files `privacy.md`, `terms.md`, and `support.md` from an absolute read-only notice directory plus the exact acknowledgement `I_CONFIRM_OPERATOR_PUBLIC_NOTICES_ARE_FINAL`; the same validation runs in `certify:production-edge`. Fixed filenames are bounded to 256 KiB, must be regular files in a real directory, are HTML-escaped and rendered once at startup, and known repository-draft wording is rejected. `deploy/public-edge/production-notices/` is git-ignored and mounted read-only; repository drafts remain reference documentation only.
