# Wave 0: source truth, three-lane evidence and parallel safety inventory

Date: 2026-10-24. Canonical issues: [#374](https://github.com/sampathkumar-co/Operator-runtime/issues/374), [C00 #375](https://github.com/sampathkumar-co/Operator-runtime/issues/375), [C01 #376](https://github.com/sampathkumar-co/Operator-runtime/issues/376), [C08 #383](https://github.com/sampathkumar-co/Operator-runtime/issues/383).

**Definition:** Wave 0 is the preparation of an *exact source and release baseline* (C00), a *three-lane evaluation and failure attribution contract* (C01), and a parallel *non-mutating C08 source/synthetic inventory*. Source preparation is not the same as a successful physical benchmark, production package attestation or release acceptance.

## Frozen and moving source are different

| Channel | Source / artifact | State |
|---|---|---|
| Published/installed stable release source declared | `mecord-connect@2.0.6`, Git SHA `b9682da964b8dfcda9b4ce65e1ba6352623bf7a5` | Source pinned. The independently downloaded *registry tarball bytes* and original installed Windows binaries are **NOT VERIFIED in Wave 0 CI**. |
| Development integration source | Exact current Git `HEAD` evaluated by CI and printed in the evidence manifest | GitHub commit changes after each merge; **do not call the moving branch the npm release**. |
| Hosted public/Developer MCP and relay | Last dated hosted snapshot in `docs/release-state.json` (2026-10-07) | Historical only. Current hosted SHA **NOT VERIFIED**. |
| Windows UIA/path lease/native helpers | Source C# `Program.cs` / PowerShell `build.ps1` and the Rust UIA `Cargo.toml` / tracked source tree, plus existing Windows build workflows | The manifest hashes source files, **not helper executables**. Physical and independently signed binary identity **NOT VERIFIED**. |
| Public Plugin | Exactly 9 names in `src/core/public-plugin-surface.ts` | Source-frozen compatibility constraint; provider operation behavior requires its own tests. |

**Machine evidence:** run `node scripts/wave0-source-manifest.mjs` from a clean full-history Git checkout. Output includes the release and candidate SHA, SHA-256 of 16 exact Git files, candidate provider registrations, tool names, Node and CI platform. An error is reported for dirty, missing or non-comparable source. CI uploads the generated JSON as a retained run artifact.

## Existing provider registration inventory

`apps/local-agent/src/runtime-factory.ts` registers the following provider families. This is a **registration inventory**, not certification of every supported operation or risk setting. On runtime creation, configured roots, installed executables, credentials, registered profiles and optional platform capabilities determine actual availability.

| Provider families | Primary source and existing tests | Scope requiring a separate contract check |
|---|---|---|
| `SystemInspectProvider`, `FilesystemProvider`, `ProjectInspectProvider` | `src/capabilities/{system,filesystem,project}.ts`; `test/filesystem.test.ts`, `test/project-inspect-pagination.test.ts` | Read/write scopes, hashes, output bounds, Windows path lease |
| `ProjectCommandProvider`, `ProjectTransactionProvider`, `ProcessProvider` | `src/capabilities/{project-command,project-transaction,process}.ts`; `test/process.test.ts` | Registered commands, execution risk, cancellation, descendant containment |
| `DockerProvider`, `SandboxedComputeProvider`, `PostgresProvider`, `VsCodeProvider` | `src/capabilities/{docker,sandboxed-compute,postgres,vscode}.ts` | Capability availability, registered profiles, allowed operations, no unauthorized external write |
| `GitProvider`, `GitCheckpointProvider`, `GitWriteProvider` | `src/capabilities/git.ts`, `git-checkpoint.ts`, `git-write.ts` | Checkpoints, worktree identities, destructive/mutation rollback |
| `ManagedBrowserProvider`, `WindowsUiaProvider` | `src/capabilities/{browser-managed,windows-uia}.ts`; `test/browser-m1.test.ts`, `test/windows-uia.test.ts` | CDP/Chrome/Edge actual outcomes, helper builds vs original Windows device |
| `WorkspaceLspEditProvider`, `WorkspaceEditTransactionProvider`, `WorkspaceEditRollbackProvider` | `src/capabilities/{workspace-lsp-edit,workspace-edit-transaction,workspace-edit-rollback}.ts` | Scoped multi-file edits and independently verified revert |
| `PerceptionProvider`, `DocumentDataProvider` | `src/capabilities/{perception,document-data}.ts` | Optional registration, visual/structured interpretation, bounded outputs |

See generated provider-registration list for precise **candidate-HEAD** membership; conditional `stateDir` and `perception` providers are not necessarily active in a given runtime.

## Versioned contract boundaries (C00-08)

| Boundary | Existing source of truth | Rule |
|---|---|---|
| Principal, delegation, resource identity | `src/core/contract-registry.ts`, `execution-context-identity.ts`, `principal-delegation.ts` | Exact authority generation/session identity, never inferred from model text. |
| Intent and goal | `src/core/intent-kernel.ts`, `task.ts`, `contract-registry.ts` | Versioned goal/intent identity and approved resource scope. |
| Plan and action | `task-orchestrator.ts`, `src/core/types.ts`, `action-identity.ts` | Canonical action ID/hash, typed risk, grant, immutable intent binding. |
| Observation | `task.ts` observation summary v1/v2, `browser-cdp-page.ts`, `windows-uia.ts` | Timestamp/freshness/provider and target identity; no silent ref substitution. |
| Verification and receipt | `verification-kernel.ts`, `task-verifier.ts`, `evaluation.ts` | Only independent postcondition qualifies; a tool `ok` or model claim is not outcome proof. |
| Compatibility | `src/core/contract-registry.ts` with exact/backward-readable policies | No silent public API change. Legacy decoding must be explicit, never a new grant. |

## Inherited open issues: evidence-based disposition

An open issue does **not** prove a current source defect, and a green unit test does **not** prove physical acceptance. The following classification is intentionally conservative.

| Issue | Observed source/test state | Wave 0 classification |
|---|---|---|
| #56 | Historical 2026-09-29 MiniWoB 20-task smoke on runtime 2.0.1; 13/20 and artifacts not a current result | HISTORICAL / NONCOMPARABLE, not a 2.0.6 product baseline |
| #151 | Quarantine for untrusted organization identity exists; independent owned/unrelated adjudication outstanding | PARTIAL SOURCE / UNRESOLVED CERTIFICATION |
| #157 | Earlier 17-writer audit in `docs/P0_DURABLE_WRITER_CENSUS_2026-10-11.md`; synthetic locks/CAS checks exist | PARTIAL CI HISTORY / CROSS-HOST NOT VERIFIED |
| #192 | Exact-generation/tombstone tests in `test/control-plane-exact-generation-integrity.test.ts` | SOURCE REGRESSION EXISTS / PHYSICAL PG RESTORE NOT VERIFIED |
| #247 | `operation-trace.ts` and historical #342 latency branch exist; source-matched total p50/p95 not measured | BENCHMARK BASELINE OUTSTANDING |
| #251 | `test/approval-path-parity.test.ts` exists, but same-host actual fresh action parity still required | SOURCE TEST EXISTS / ORIGINAL CHROME NOT VERIFIED |
| #279 | Windows Job Object/source/native tests exist, historical Windows CI containment race disclosed | HOSTED SYNTHETIC EVIDENCE / ORIGINAL PHYSICAL NOT VERIFIED |
| #293 | Legacy approved-but-deferred receipt recovery remains a quarantined real case | PROTECTED ORIGINAL STATE / NO REPLAY |
| #312 | Current `npm-remote-ci.yml` explicitly includes both adaptive-intelligence and verified-plan-runtime source roots | SOURCE FILTER FIX PRESENT / SOURCE-MATCHED RELEASE GATE SEPARATE |
| #351 | Historical original receipts quarantined, independent hosted recovery inspection/owner acceptance incomplete | RELEASE HOLD / LIVE EXTERNAL DEPENDENCY |
| #369 | Secure browser sign-in is integrated into the stable 2.0.6 source by merged #373 at `b9682da964b8dfcda9b4ce65e1ba6352623bf7a5`; earlier #370/#372 remain open historical integration branches and are not the accepted production basis. Relevant Control Center tests and owner-reported doctor exist, but original-device browser sign-in and hosted deployment need separate evidence. | SOURCE IN RELEASE / PHYSICAL HOSTED ACCEPTANCE NOT VERIFIED |


**2026-10-24 reconciliation correction:** Issue #369 must not be classified as only a proposal because the release-convergence PR #373 is merged into the declared 2.0.6 release SHA. Conversely, the merged source does not establish that the original Windows Control Center or independently authenticated hosted runtime passed physical acceptance. The eleven open inherited issues remain open until their distinct criteria are proved; this inventory is source-truth accounting, not permission to clear quarantined recovery state.

**Older draft PRs:** #359 is reconstructed external benchmark control, not production capability. #368 is unmerged, reusable generic AI proposal/budget work requiring selective integration. #342 is historical performance code without current source-matched measurements. None is auto-merged or counted as a success baseline.

## C01 three-lane truth contract

`scripts/wave0-evaluation.mjs` requires frozen SHA identities, exact scenario revision, seed, model/config digest, runner, environment and independent oracle/result digests. No records produce `NOT_RUN`, not 0% success or an invented pass.

- **Lane A:** model-only decisions using frozen observations, no Mecord provider dispatch; real model/scorer campaign still **NOT_RUN**.
- **Lane B:** scripted, model-independent Mecord provider execution with independent outcome oracle. Focused synthetic file trace merged in #398; browser discovery fixtures proposed in #402. Full prescribed action matrix **NOT RUN**.
- **Lane C:** same real model/seed/environment and paired Mecord-vs-direct tool outcome receipts. Any missing or mismatched arm fails closed. Actual paired real-world campaign **NOT_RUN**.

Even a full, self-reported suite yields `REPORTED_FULL_COVERAGE_UNVERIFIED`, not CI/physical acceptance. Fifty held-out realistic journeys and 125 MiniWoB tasks cannot be claimed passed from synthetic regression tests. Missing original GPT-OSS controller source and historical 102/125 are explicitly **NOT REPRODUCIBLE** as a certified 2.0.6 result.

## C08 parallel safety inventory

Existing source tests include `test/approval-path-parity.test.ts`, `test/cross-component-journal-concurrency.test.ts`, `test/control-plane-exact-generation-integrity.test.ts`, `test/relay-client.test.ts`, `test/windows-junction-path-authority.test.ts`; historical 17-writer classification is in `docs/P0_DURABLE_WRITER_CENSUS_2026-10-11.md`. Prior tests are **not** new exact-source CI proof until rerun.

No original `.operator` state, uncertain action receipt, ACK, relay outbox, SSH trust or VPS service is read, reset or modified by this foundation workflow. Physical independent signer, Windows process containment and two-host restore/cross-host authority remain **NOT VERIFIED**.

## Wave 0 acceptance ledger

| Work | Source/CI-ready state | Remaining gate |
|---|---|---|
| C00-01, C00-05 | Frozen release-source and moving-HEAD hash generator; channel-specific docs previously merged #391 | Downloaded npm artifact, helper binary/provenance and exact original doctor evidence |
| C00-02, C00-03, C00-04 | Runtime provider registration / PR classification / historical-issue disposition documented | Per-operation authority/risk/test/OS contract evidence; reopen only demonstrated missing behavior |
| C00-06 | GitHub source inventory only | Local-only source uniqueness cannot be established while laptop offline |
| C00-07 | Existing CI, Windows build, dependency SBOM; dedicated Wave 0 generator workflow | Exact frozen release SHA registry and physical package integrity; do not inherit green from a newer candidate |
| C00-08 | Existing contract registry mapped to intent/goal/action/observation/receipt | Formal cross-provider conformance acceptance and any future schema changes |
| C00-09 | PR evidence described below | Enforce branch checks/mandatory fields under repository protections |
| C01-01..10 | Strict run schema, provenance, pairing, failure taxonomy and `NOT_RUN` reporting | Actual scored Lane A/B/C campaigns; >=50 held-out tasks; reproducible 125 MiniWoB and external device evidence |
| C08-01..13 | Safe source-inventory starting point | Cross-host and original Windows physical/recovery acceptances later |

**Every future engineering PR must carry:** exact baseline and HEAD SHAs; source/provider files; identified defect or preserved implementation; authority/side-effect risk; synthetic tests and commands; actual CI run URLs; performance baseline or `NOT_MEASURED`; rollback; physical acceptance or explicit `NOT_RUN`; objective postcondition / external independent scorer; remaining dependencies. The branch/protection policy must enforce this, not merely request it in prose.

Wave 0 **source-preparation** can be CI-verified without the laptop. Wave 0 **full certification** remains **NOT ACCEPTED** until the applicable registry, physical and live held-out evidence exists. No forced percentage is appropriate.
