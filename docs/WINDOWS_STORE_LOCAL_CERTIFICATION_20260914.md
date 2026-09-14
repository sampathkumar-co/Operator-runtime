# Windows Store local certification — 2026-09-14

This record captures the final local unsigned Microsoft Store package audit on branch `codex/chatgpt-publication-security-p0-20260913`. The certified implementation was committed in three bounded steps: `a836b7c` (Store packaging audit), `2fc591b` (Windows path authority and release workflows), and `09db0f3` (security authority and public-edge hardening).

## Clean-checkout integration proof

Before `09db0f3` was committed on the shared branch, its exact 88-file tree was reconstructed on a fresh worktree based on `2fc591b` with no scratch helpers or generated artifacts copied in. Using the certified Node v22.23.2 runtime and a freshly built Windows path-lease helper, that clean tree passed MCP 51/51, relay 29/29, red-team 6/6, and the full Windows root suite at 302 total / 286 passed / 0 failed / 16 expected environment skips. The Git index tree transferred to the shared branch matched that certified clean-worktree tree byte-for-byte before commit.

## Candidate artifact

- File: `artifacts/windows-release-audit-20260914/Operator-1.0.0.0-x64.msix`
- SHA-256: `74dd941795487e16b12d0e359f5703bafdc55ec40250f5f6861eccaeac1fcc38`
- Unpacked file count: 2701
- Identity: `SPLCART.SplcartOperator`
- Publisher: `CN=6F726FAE-9AD9-4643-A991-7E86CBD7C967`
- Version / architecture: `1.0.0.0` / `x64`
- Display / publisher display names: `SPLCART Operator` / `SPLCART`
- Restricted capability: `runFullTrust`

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

## Remaining external gates

This is local unsigned-package certification, not final production approval. A trusted production signing identity/certificate, RFC 3161 timestamped final package, Partner Center submission/certification, production OAuth/public MCP deployment, live ChatGPT certification, and real-user/reviewer evidence remain external gates. The legacy .NET Framework compiler used for the path-lease helper does not provide deterministic output across separate compilations, so cross-build reproducibility is not claimed for that helper; exact-build package/source hash equality is verified.