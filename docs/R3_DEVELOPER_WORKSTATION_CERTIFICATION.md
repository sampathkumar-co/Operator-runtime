# R3 Developer Workstation OS Certification

Status: **IMPLEMENTED_NOT_CERTIFIED**

Branch: `program/r3-final-closeout`

This document is the release-evidence ledger for R3. Documentation is not proof by itself. R3 may move to **CERTIFIED** only when the exact closeout head passes the repository qualification lanes and the exit-gate test below.

## R3-DEV-01 — Workspace Graph

Implementation:
- `src/core/workspace-graph.ts`
- typed nodes for workspace/repository/worktree/branch/commit/files/symbols/diagnostics/tests/terminals/processes/ports/containers/databases/browser/UI/screenshots/tasks/plans/approvals/evidence/artifacts/checkpoints/intent;
- content-addressed graph identity and validated edges.

Evidence:
- `test/workspace-developer-session.test.ts`
- `test/r3-developer-objective-e2e.test.ts`

## R3-DEV-02 — Developer Session

Implementation:
- `src/core/developer-session.ts`
- `src/core/developer-session-review.ts`
- durable objective, acceptance criteria, constraints, graph/plan refs, tasks, artifacts, approvals, checkpoints, explicit active resource identities, status and resume state;
- immutable pause manifest;
- reboot-safe resume;
- external review summary.

Evidence:
- `test/workspace-developer-session.test.ts`
- `test/developer-session-review.test.ts`
- `test/r3-developer-objective-e2e.test.ts`

## R3-DEV-03 — Code intelligence

Implementation:
- `src/core/workspace-code-index.ts`
- `src/core/lsp-workspace-edit.ts`
- `src/core/workspace-semantic-intelligence.ts`
- bounded text/symbol search;
- LSP WorkspaceEdit ingestion;
- declaration syntax tree;
- call graph;
- reverse dependency impact;
- changed-symbol impact and affected-test selection;
- conservative semantic three-way conflict assistance.

Evidence:
- `test/workspace-code-index.test.ts`
- `test/lsp-workspace-edit.test.ts`
- `test/workspace-semantic-intelligence.test.ts`

## R3-DEV-04 — Transactional editing

Implementation:
- `src/core/multi-file-edit-plan.ts`
- `src/core/developer-edit-workflow.ts`
- `src/capabilities/workspace-edit-transaction.ts`
- `src/capabilities/workspace-edit-rollback.ts`
- SHA-bound multi-file plans and preview;
- stage-all-before-mutate transaction semantics;
- crash recovery and failure rollback;
- trusted formatter/import-organization roles;
- verification/test graph;
- optional sensitive immutable rollback artifact for successful commits;
- destructive committed-edit rollback with its own durable journal and exact hash postconditions.

Evidence:
- `test/multi-file-edit-plan.test.ts`
- `test/workspace-edit-transaction.test.ts`
- `test/workspace-edit-rollback.test.ts`
- `test/developer-edit-workflow.test.ts`
- `test/r3-developer-objective-e2e.test.ts`

## R3-DEV-05 — Hermetic execution

Implementation:
- `src/core/developer-worktree.ts`
- `src/core/developer-runtime-ownership.ts`
- `src/core/developer-container.ts`
- exact-commit detached worktrees;
- per-session process and TCP-port ownership;
- exact process-instance restart recovery;
- local-only disposable Docker environments;
- pinned image digest, no network, read-only root filesystem, dropped capabilities, no-new-privileges, bounded CPU/RAM/PIDs, one owned workspace mount;
- deterministic durable environment identity;
- crash cleanup/reconciliation.

Evidence:
- `test/developer-worktree.test.ts`
- `test/developer-runtime-ownership.test.ts`
- `test/developer-session-process-ownership.test.ts`
- `test/developer-container.test.ts`

## R3-DEV-06 — Artifact / Evidence Pack service

Implementation:
- `src/core/artifact-store.ts`
- `src/core/evidence-pack.ts`
- `src/core/developer-verification.ts`
- content-addressed patch/build/test/log/screenshot/SBOM/deployment/review/evidence artifacts;
- immutable trusted-command verification receipts;
- acceptance-criterion Evidence Packs;
- raw command output excluded from verification receipts;
- external review summary bound to durable session + Evidence Pack.

Evidence:
- `test/artifact-evidence-pack.test.ts`
- `test/developer-verification.test.ts`
- `test/developer-session-review.test.ts`
- `test/r3-developer-objective-e2e.test.ts`

## R3 exit gate

Required statement:

> A development objective can be paused/rebooted/resumed, safely edited/tested/verified/rolled back, and externally reviewed without trusting agent prose.

Direct proof:
- `test/r3-developer-objective-e2e.test.ts`

The test must prove, in one objective lifecycle:
1. isolated Git worktree creation at an exact commit;
2. code-index + semantic graph observation;
3. durable Developer Session + Workspace Graph binding;
4. pause and fresh-coordinator resume from immutable manifest;
5. SHA-bound transactional edit with rollback artifact;
6. explicit committed edit rollback;
7. reapply;
8. edit workflow coverage for formatter/import roles, trusted verification commands and required test paths;
9. trusted-command receipt validation;
10. Evidence Pack completion;
11. external review-summary publication.

## Qualification gate

The exact certification head must pass:
- CI;
- Platform Matrix;
- Windows Signing Smoke;
- NPM Remote Runtime CI;
- Adaptive Intelligence Core when triggered for the integrated roadmap head;
- Verified Plan Runtime when triggered for the integrated roadmap head.

No skipped/failed mandatory lane may be represented as certification.

## Certification record

Head: pending

Qualification:
- CI: pending
- Platform Matrix: pending
- Windows Signing Smoke: pending
- NPM Remote Runtime CI: pending
- Adaptive Intelligence Core: inherited roadmap qualification; final integrated roadmap head must re-run
- Verified Plan Runtime: inherited roadmap qualification; final integrated roadmap head must re-run

R3 remains **IMPLEMENTED_NOT_CERTIFIED** until this section is updated from actual workflow results.
