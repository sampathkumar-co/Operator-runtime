# Mecord Connect — Development Progress

Status date: **2026-09-27**

This document answers the development question "what is actually finished now?" It is about repository/source progress. For what is currently deployed in production, use `docs/CURRENT_RELEASE_STATE.md`.

## Executive status

| Area | Repository status | Production status |
| --- | --- | --- |
| Core execution/policy/evidence runtime | Complete and CI-certified | Deployed |
| Browser semantic kernel | Complete and CI-certified | Available in existing private runtime path |
| Windows UI Automation kernel | Complete and CI-certified | Available in existing private runtime path |
| Git / project / Docker / PostgreSQL / VS Code adapters | Complete and CI-certified | Existing production/private runtime snapshot |
| Relay + pairing + multi-device routing | Complete and CI-certified | Deployed architecture |
| Public ChatGPT-facing surface | Complete at 9 review-bounded tools | Deployed |
| Existing Developer surface | Historical production snapshot | 24 tools deployed |
| Stage 3 bounded autonomous execution | Complete and CI-certified | Successor deployment still required for latest source |
| Windows RDC parity layer | Complete and CI-certified | **Not deployed yet** |
| Stage 4 shared-state multi-agent runtime | Complete and CI-certified | **Not deployed yet** |
| Successor private/Developer surface | Complete and CI-certified at 30 tools | **Not deployed yet** |
| Linux/macOS runtime regression | Green | Runtime supported; advanced GUI parity not claimed |
| Linux/macOS advanced GUI automation | Intentionally out of current scope | Not claimed |
| OpenAI directory verification/submission | External blocker | Not completed |

## Certified successor

Branch:

`feature/windows-parity-stage4`

Runtime-certified code commit:

`288d5a1c5ad5742f0f041e42740010eeda50dd92`

Documentation-only commits after that point do not change the certified runtime code.

The code commit passed the following top-level workflows on the same immutable head:

- CI #1375
- Platform Matrix #1145
- Windows Signing Smoke #1146
- NPM Remote Runtime CI #759

The CI run included green gates for:

- Windows RDC parity certification
- Stage 4 multi-agent certification
- Stage 3 autonomous certification
- core runtime
- MCP v2 + Inspector E2E
- security red-team
- performance regression
- relay WebSocket E2E
- Windows UIA
- Windows path authority
- Windows DPAPI helper
- public edge container smoke
- Windows unsigned MSIX packaging

The platform matrix passed Windows, macOS and Linux runtime regression on the same code head.

## Progress by major stage

### Stage 1 — execution foundation

**Complete.**

Includes capability routing, local policy, provenance, evidence, Task Capsules, rooted filesystem access, shell-free process execution, Git inspection, semantic project inspection, local-agent authentication and audit.

### Stage 2 — semantic computer control

**Complete for the certified target.**

Includes persistent browser CDP semantics and the Windows semantic kernel using UI Automation/Win32 fallback. Windows remains the advanced desktop-control target; Linux/macOS GUI parity is not part of the current completion claim.

### Stage 3 — bounded autonomous execution

**Complete in the repository and CI-certified.**

Includes:

- durable semantic workflows;
- dependency-aware child work;
- retries and loop detection;
- pause/resume/cancel;
- crash-safe persisted execution state;
- preemptive cancellation into providers;
- provider reliability/latency learning that cannot change policy/risk;
- evidence-backed postconditions.

### Windows RDC-parity sprint

**Complete and CI-certified.**

Added the raw-control gaps that previously made Desktop Commander/RDC more capable for generic Windows machine work:

- `file.info`;
- `file.search`;
- `file.manage` for mkdir/copy/move/remove;
- `terminal.session` for interactive processes;
- `process.inspect`;
- `process.manage` for fingerprinted current-user process termination.

The implementation keeps Mecord's stricter authority model: no unrestricted shell, no cross-user process kill, no critical Windows process termination, no weakening of the reparse-point/path-authority helper, and destructive operations remain approval-gated.

### Stage 4 — shared-state multi-agent execution

**Complete and CI-certified.**

Implemented:

- durable team missions;
- supervisor/planner/coder/tester/browser/UI/verifier/general worker roles;
- worker registration/heartbeat/revocation;
- dependency and priority scheduling;
- concurrency/attempt/wall-clock/lease budgets;
- work-item leases;
- explicit resources;
- resource locks and revisions;
- base-revision conflict detection;
- per-worker/per-work capability authorization;
- canonical risk checks before each worker action;
- inferred action-resource binding;
- CAS shared blackboard;
- uncertainty tracking for interrupted mutation;
- `NEEDS_RECONCILIATION`;
- supervisor/verifier reconciliation;
- preemptive cancellation;
- verifier coverage requirement;
- verifier-gated final mission state;
- authenticated `/v1/teams` API;
- Control Center team visibility;
- real-runtime Stage-4 E2E tests.

Stage 4 is **not** an embedded LLM. It is the coordination and authority substrate that external agents use.

## Current source vs production

Do not mix these states:

### Production now

- source: `94becbf734817121fbea1a017b9e1b10c144d125`;
- public tools: **9**;
- Developer tools: **24**;
- npm: `mecord-connect@1.0.1`.

### Certified successor

- runtime code: `288d5a1c5ad5742f0f041e42740010eeda50dd92`;
- public tools: still **9** by design;
- private/Developer source surface: **30**;
- Windows RDC parity: complete;
- Stage 4: complete.

The successor does not become production simply because CI is green. It still needs the normal merge/deployment/release-state promotion.

## What is actually left

For the scope completed in this branch, there is no known repository implementation gap in Windows RDC parity or Stage 4 certification.

The meaningful next work is:

1. review and merge PR #42;
2. deploy the successor runtime;
3. promote `docs/release-state.json` only after deployment facts are verified;
4. verify the live Developer endpoint imports the intended 30-tool private surface;
5. run fresh live ChatGPT/Developer workflows against a real paired Windows device;
6. continue the external OpenAI verification/app-directory process;
7. optionally close remaining RDC convenience gaps such as content search, rich file previews and native PDF/Excel/DOCX workflows, without weakening Mecord's security/verification model.

See `docs/RDC_VS_MECORD_CONNECT.md` for the current feature-by-feature comparison.
