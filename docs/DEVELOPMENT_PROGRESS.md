# Mecord Connect — Development Progress

Status date: **2026-09-27**

This document answers "what is actually finished in source?" For deployed production facts, use `docs/CURRENT_RELEASE_STATE.md`.

## Executive status

| Area | Repository/source | Production |
| --- | --- | --- |
| Core execution / policy / evidence | ✅ Complete + CI-certified | Deployed |
| Browser semantic kernel | ✅ Complete + CI-certified | Existing private runtime |
| Windows semantic/UIA kernel | ✅ Complete + CI-certified | Existing private runtime |
| Git / project / Docker / PostgreSQL / VS Code adapters | ✅ Complete + CI-certified | Existing private runtime |
| Relay / pairing / multi-device identity + routing | ✅ Complete + CI-certified | Deployed architecture |
| Public MCP surface | ✅ 9 tools | ✅ 9 tools deployed |
| Deployed Developer MCP | ✅ 32 grouped tools | ✅ 32 grouped tools live |
| Windows RDC parity | ✅ Complete + CI-certified | ✅ Deployed |
| Stage 3 bounded autonomous loop | ✅ Complete + CI-certified | ✅ Deployed |
| Stage 4 shared-state multi-agent runtime | ✅ Complete + CI-certified | ✅ Deployed |
| Stage 5 verified procedural memory | ✅ Complete + CI-certified | ✅ Deployed |
| Stage 6 cross-application world model | ✅ Complete + CI-certified | ✅ Deployed |
| Stage 7 trusted cross-device resource pool | ✅ Complete + CI-certified | ✅ Deployed |
| Stage 8 organization-scale execution | ✅ Complete + CI-certified | ✅ Deployed |
| Stage 9 bounded self-optimization | ✅ Complete + CI-certified | ✅ Deployed |
| Stage 10 autonomous digital operations layer | ✅ Complete + CI-certified | ✅ Deployed |
| Private/Developer surface | ✅ **32 grouped tools** | ✅ **32 grouped tools live** |
| Linux/macOS runtime regression | ✅ Green | Runtime supported; advanced GUI parity not claimed |
| OpenAI directory verification/submission | External | Not completed |

## Certified and deployed Stage 1–10 runtime

Runtime-certified Stage-5–10 code head: `83fbcf68cfe97bb4fe4b15b66b76f1f54dad6dce`

Merged/deployed production source: `3361b2f77d2b04028d514b178bd4a246fc863e6c`

The deployed runtime is gated together with the predecessor runtime: Stage 3 autonomous certification, Windows RDC parity, Stage 4 multi-agent, Stage 5–10 certification, core runtime, MCP/Inspector, relay WebSocket E2E, security red-team, performance regression, Windows UIA/path authority/native packaging, and the Windows/macOS/Linux platform matrix.

## Stage progress

### Stage 1 — Secure computer/execution foundation
**Complete.** Capability routing, local policy, provenance, evidence, rooted filesystem authority, shell-free process execution, Git/project semantics, local-agent auth and audit.

### Stage 2 — Semantic computer control
**Complete for the certified target.** Persistent browser CDP plus Windows UIA/Win32 semantic control. Windows is the advanced GUI target; Linux/macOS GUI parity is intentionally not claimed.

### Stage 3 — Bounded autonomous task loop
**Complete + certified.** Durable Task Capsules, typed goals/workflows, dependency graph execution, retry/repair/reobserve, pause/resume/cancel, crash recovery, deadlines, no blind mutating retry, independent verification and evidence-backed completion.

### Stage 4 — Shared-state multi-agent execution
**Complete + certified.** Durable missions, worker roles/leases, dependency scheduling, budgets, resource locks/revisions, CAS blackboard, uncertain-mutation reconciliation, cancellation, verifier coverage and verifier-gated completion.

### Stage 5 — Verified procedural memory
**Complete + certified.**
- only independently verified outcomes can be promoted;
- procedure assumptions are stored as bounded fingerprints rather than raw secret-bearing values;
- expiry, invalidation and automatic suspension are supported;
- reuse requires matching scope/assumptions/capability needs;
- verification and reuse outcome receipts are retry-idempotent.

### Stage 6 — Cross-application intelligence
**Complete + certified.**
- one durable entity/relation graph spans browser, application, filesystem, Git, database, process, device, project and organization observations;
- source/evidence/freshness/confidence are retained per claim;
- conflicting observations remain explicit rather than being silently overwritten;
- only passing Stage-4 verifiers can publish normal agent world observations;
- world publication is commitment-bound for exact replay;
- secret-bearing keys, nested credential structures and obvious credential strings are rejected.

### Stage 7 — Trusted cross-device orchestration
**Complete + certified.**
- paired devices advertise a bounded resource profile inside the signed relay hello;
- scheduling uses active account-owned relay sessions rather than caller-forged capacity;
- capability/tag/GPU/memory/capacity filtering is bounded;
- project/default device authority remains fail-closed;
- long-lived operation reservations prevent overbooking;
- operation UUIDs keep durable device affinity;
- reservation lifecycle survives retries/reconnects and releases on terminal completion;
- signed per-host concurrent-work capacity is honored within configured bounds.

### Stage 8 — Organization-scale execution
**Complete + certified.**
- organization programs compile many target scopes into Stage-4 missions;
- canary-first waves and bounded parallel blast radius;
- explicit verified promotion before expanding rollout;
- failed/cancelled canaries halt expansion;
- scope prefixes constrain target authority;
- partial wave/start failures compensate already-created/resumed missions so hidden work is not orphaned.

### Stage 9 — Bounded self-optimizing execution
**Complete + certified.**
- learns aggregate verified/failed reliability, retry rate, latency and cost;
- learned strategy adjustment is intentionally small and bounded;
- concurrency recommendations stay inside caller policy floor/ceiling;
- optimizer state carries no permissions/approvals/recovery authority;
- learning receipts are retry-idempotent;
- learning cannot grant capability, lower canonical risk, widen scope, bypass approval or remove verification.

### Stage 10 — Autonomous digital operations layer
**Complete + certified.**
- durable outcome contract with objective, scope, success conditions and world pre/postconditions;
- client-stable UUID + canonical submission digest gives idempotent submit semantics;
- explicit work graphs or bounded outcome auto-planning;
- auto-planning always requires a caller-declared capability subset **and exact Stage-4 resource keys**;
- the authority envelope can only restrict the machine's actual locally allowed capabilities;
- default auto-plan risk is read and dynamic-risk capabilities are excluded;
- verified procedure reuse/capture, Stage-4 team execution and Stage-8 organization rollouts compose under one governor;
- final state cannot become `VERIFIED` from worker self-report; underlying verifier + world postconditions must pass;
- organization procedure capture hashes actual target verifier results;
- operation final learning is crash/retry-idempotent;
- relay Stage-10 operations reserve a trusted paired device, keep durable operation-to-device affinity and preserve resource capacity across the operation lifecycle;
- grouped private MCP `operations` and read-only `knowledge.inspect` expose the new layer without adding raw authority bypasses.

## Current source vs production

### Production now
- production source: `3361b2f77d2b04028d514b178bd4a246fc863e6c`;
- public tools: **9**;
- Developer tools: **32 grouped tools**;
- npm: `mecord-connect@1.0.1` until the separately authenticated patch publish.

### Certified runtime lineage
- Stage-5–10 runtime certification head: `83fbcf68cfe97bb4fe4b15b66b76f1f54dad6dce`;
- merged/deployed mainline source: `3361b2f77d2b04028d514b178bd4a246fc863e6c`;
- Windows RDC parity + Stages 3–10: complete, CI-certified and deployed.

## Remaining release work

1. publish the separately authenticated npm patch release so `npx mecord-connect@latest` installs the Stage-1–10 runtime;
2. run fresh real paired-Windows Stage-10 workflows through the live ChatGPT/Developer path when the external OpenAI verification path is available;
3. continue the external OpenAI verification/app-directory process separately.

There is no known Stage-1–10 repository or production-edge implementation blocker.
