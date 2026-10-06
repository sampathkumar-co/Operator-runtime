# R1 Canonical Trusted Runtime Certification

Status: **IMPLEMENTED_NOT_CERTIFIED**

Branch: `program/r1-r3-closeout-20261006`

R1 is implemented. It moves to **CERTIFIED** only when the exact closeout head passes the mandatory R1 and repository qualification lanes.

## R1-FND-01 — Canonical source reconciliation

- `docs/r1-canonical-source.json` records the required production/history ancestors.
- `scripts/verify-r1-canonical-source.ts` proves the current head contains every required ancestor and that recorded production source truth is reachable.
- Historical/experimental branches do not grant production status.

## R1-FND-02 — Release truth ledger

- `src/core/release-truth.ts` is the canonical explicit source/deployed production distinction.
- `scripts/verify-release-truth.ts` validates source package versions, deployed source SHA, endpoints and release-state consistency.
- `scripts/generate-r1-release-evidence.ts` produces immutable source/tree/release/contract/lock/native-boundary evidence.

## R1-FND-03 — Root workspace and strict type graph

- `workspace-layout.json` declares package boundaries without shadowing independently authoritative nested lockfiles.
- `tsconfig.production.json` is the strict cross-package production type graph.
- `tsconfig.json` declares root project references.
- `npm run typecheck:production` is a mandatory R1 fast gate.

## R1-FND-04 — Contract/schema registry

- `src/core/contract-registry.ts` includes principal, delegation, intent, goal, plan/revision/node, task, action/attempt, authority, resource/revision, lease/fence, evidence, receipt, artifact, event, evaluation run, execution context and adaptive control contracts.
- Current/previous task-observation schema readability is explicit and tested.

## R1-FND-05 — Monolith decomposition

Characterization-preserving extraction is present across the requested boundaries:

- task orchestration public contracts: `src/core/task-orchestrator-contracts.ts`;
- local HTTP trust boundary: `apps/local-agent/src/server-boundary.ts`;
- local persistent-state construction: `apps/local-agent/src/state-components.ts`;
- lifecycle/shutdown coordination: `apps/local-agent/src/runtime-lifecycle.ts`;
- browser runtime was already split across connection/page/frame modules;
- capability/runtime construction remains isolated behind `apps/local-agent/src/runtime-factory.ts`.

The existing behavior suites plus `test/runtime-lifecycle.test.ts` are the characterization gate.

## R1-FND-06 — CI lane redesign

`.github/workflows/r1-canonical-runtime.yml` provides:
- fast PR type + contract/source gate;
- integration qualification;
- scheduled nightly/fault qualification;
- immutable release-evidence artifact generation.

## R1-FND-07 — Release Evidence Pack

The release candidate lane publishes `artifacts/r1/release-evidence.json` plus SHA-256 proof and binds:
- repository/head/tree;
- release truth;
- contract registry digest;
- independently locked package digests;
- native boundary lock digests where present;
- workflow identity.

## Exit gate evidence

R1 certification requires:
- R1 Canonical Runtime workflow: green;
- repository CI: green;
- Platform Matrix: green;
- Windows Signing Smoke: green;
- NPM Remote Runtime CI: green;
- schema compatibility tests: green;
- rollback/hardening tests: green.

Certification head and workflow results are recorded only after the exact final head completes those gates.
