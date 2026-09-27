# Mecord Connect — Current Release State

Status date: **2026-09-27**

This file is the canonical human-readable current-state summary. Machine-readable values live in `docs/release-state.json`. Older certification and gate documents may preserve historical evidence, but they must not override this file for current production facts.

## Production

- production source: `94becbf734817121fbea1a017b9e1b10c144d125`
- public MCP: `https://operator.splcart.in/mcp`
- public surface: exactly **9** tools
- Developer MCP: `https://developer.operator.splcart.in/mcp`
- Developer surface: exactly **24** tools
- Developer pairing route: **404** by design
- npm: **`mecord-connect@1.0.1`** under `latest`

Live verification on 2026-09-24 confirmed both health endpoints report the same production source commit, with public toolCount 9 and Developer toolCount 24. The deployed image also rejects traversal, drive-relative, UNC and glob `git.diff` path filters before agent dispatch.

## Certified source successor (not deployed yet)

The repository now has a certified Stage-1–10 successor on branch `feature/stage5-10-agent-os`, with runtime head `83fbcf68cfe97bb4fe4b15b66b76f1f54dad6dce`.

This successor is **not the production deployment yet**. Until merge/deployment/release-state promotion occurs, the production facts above remain authoritative.

Successor changes include:

- public review-bounded MCP surface remains exactly **9** tools;
- private/Developer source surface expands from the deployed 24 tools to **32 grouped semantic tools**;
- Windows RDC-parity primitives remain included;
- Stage 4 durable shared-state multi-agent coordination remains included;
- **Stage 5:** verified procedural memory with assumption fingerprints, expiry/invalidation, verifier-only promotion and receipt-idempotent reuse outcomes;
- **Stage 6:** evidence-backed cross-application world model with freshness, multi-source conflicts, verifier-committed publication and nested-secret rejection;
- **Stage 7:** signed paired-device resource advertisements, bounded device-capacity reservations, operation-to-device affinity and lifecycle-aware reservation renewal/release;
- **Stage 8:** organization-scale canary/wave execution with bounded blast radius, explicit verified promotion, halt-on-failure and compensating cleanup;
- **Stage 9:** bounded authority-neutral strategy/concurrency optimization that cannot grant capabilities, lower risk, widen scope, bypass approval or remove verification;
- **Stage 10:** governed digital operations with durable/idempotent outcome contracts, explicit capability+resource authority envelopes for auto-planning, world pre/postconditions, verified procedure reuse/capture, Stage-4/8 execution and final verification receipts;
- private grouped MCP `operations` and `knowledge.inspect` surfaces for Stage-10 control and read-only verified memory/world/optimizer inspection;
- Linux/macOS runtime regression remains supported, while advanced desktop GUI parity remains Windows-first.

The Stage-5–10 branch is CI-gated together with all predecessor certification, including Stage 3 autonomous execution, Windows RDC parity, Stage 4 multi-agent, core runtime, MCP/Inspector, relay WebSocket, security red-team, performance regression, Windows UIA/path-authority/native packaging, and the Windows/macOS/Linux platform matrix.

Deployment remains a separate state transition. Do not promote `docs/release-state.json` or the production source/tool counts until the successor is actually merged and deployed.

## Version policy

The public product/plugin version and the local npm runtime version are deliberately related but not identical:

- public product / plugin snapshot: **1.0.0**
- npm runtime: **1.0.1**

The public version tracks the stable public MCP schema/review snapshot. The Windows runtime may receive patch-only updates without forcing a new public plugin version. Tests must enforce the declared release-state values, matching public major/minor compatibility, and a runtime patch version that is not older than the public snapshot.

## OpenAI-side state

The currently deployed software/runtime release is complete. The certified successor above still requires merge/deployment/promotion before its **32-tool Developer surface and Stage-1–10 runtime** are live. The remaining external limitation for directory publication is OpenAI-side:

- developer verification: blocked/rejected externally;
- app-directory submission: not submitted;
- live Developer ChatGPT connection: unavailable until the OpenAI verification issue is resolved.

Do not reinterpret those OpenAI-side blockers as a failure of the live public or Developer MCP servers.

## Audit checkout rule

A directory name such as `Mecord-Current-Main` is not proof of revision identity. For a release audit, run the verifier from the current source and optionally point it at a separate frozen checkout:

```powershell
npm run verify:release-checkout -- "C:\\path\\to\\frozen-production-checkout"
```

If no path is supplied, it checks the current repository. The verifier compares the target checkout with the production source commit recorded in `docs/release-state.json` and requires a clean working tree. A detached HEAD is acceptable for an immutable audit snapshot when those checks pass. A newer source-successor checkout is expected to fail this production-snapshot check until that successor is actually deployed and the release-state record is updated.

## Trusted project commands

`project.commands` is intentionally empty unless the local user configures a trusted command registry. An empty registry is fail-closed behavior, not a runtime failure. The public response now reports `setupRequired: true` plus a safe setup hint when no registry is configured.
