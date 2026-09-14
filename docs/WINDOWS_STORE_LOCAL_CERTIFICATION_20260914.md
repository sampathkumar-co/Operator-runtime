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

Final local certification on this fully recovery-hardened tree: relay package 33/33, MCP TypeScript/E2E 52/52, red-team 6/6, root Windows suite 305 total / 289 passed / 0 failed / 16 expected environment skips, all five real junction tests executed, path-lease self-test green, syntax/import checker green, and `git diff --check` green.
