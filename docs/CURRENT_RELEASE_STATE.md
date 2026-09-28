# Mecord Connect — Current Release State

Status date: **2026-09-28**

This file is the canonical human-readable current-state summary. Machine-readable values live in `docs/release-state.json`. Older certification and gate documents may preserve historical evidence, but they must not override this file for current production facts.

## Production

- production source: `0c28cf8df77369c04fc3b85ed9d16c8def490546`
- public MCP: `https://operator.splcart.in/mcp`
- public surface: exactly **9** tools
- Developer MCP: `https://developer.operator.splcart.in/mcp`
- Developer surface: exactly **32** grouped tools
- Developer pairing route: **404** by design
- npm: **`mecord-connect@1.0.1`** under `latest`

Live verification on 2026-09-28 confirmed both health endpoints report source `0c28cf8df77369c04fc3b85ed9d16c8def490546`, with public toolCount 9 and Developer toolCount 32. The deployed edge container is healthy, the Developer pairing route remains 404 by design, and the production activation retained an automatic rollback backup.

## Stage 1–20 production status

The hardened Stage-1–10 foundation and Stage-11–20 evolution successor are now **merged and deployed to production**.

Production now includes:

- the unchanged public review-bounded **9-tool** MCP surface;
- the **32-tool grouped private/Developer** MCP surface;
- Windows RDC-parity primitives;
- Stage 3 bounded autonomous execution;
- Stage 4 durable shared-state multi-agent coordination;
- Stage 5 verified procedural memory;
- Stage 6 evidence-backed cross-application world state with verifier-committed publication;
- Stage 7 signed paired-device resource scheduling and operation-lifetime reservations;
- Stage 8 canary-gated organization-scale execution;
- Stage 9 bounded authority-neutral execution optimization;
- Stage 10 governed digital operations with explicit authority envelopes, world pre/postconditions and verifier-backed completion.
- Stage 11 multimodal perception graph and ambiguity-safe semantic/visual grounding;
- Stage 12 bounded sandboxed JavaScript/Python compute;
- Stage 13 durable event waits, publication and wake/deadline handling;
- Stage 14 temporal world-history transitions without raw sensitive-value retention;
- Stage 15 signed semantic cross-device continuation with destination authority/capability/resource/world/artifact proofs;
- Stage 16 enterprise policy narrowing and authenticated principal propagation;
- Stage 17 bounded capability SDK contracts;
- Stage 18 evaluation/reliability fabric;
- Stage 19 verified Teach Mode, durable Studio workflow execution, reconciliation and Control Center surface;
- Stage 20 continuous desired-state reconciliation with bounded remediation and Control Center surface.

The earlier Stage-5–10 certification head `83fbcf68cfe97bb4fe4b15b66b76f1f54dad6dce` remains historical evidence; the current deployed merged mainline source is `0c28cf8df77369c04fc3b85ed9d16c8def490546`, built at `2026-09-28T12:25:44Z`.

The npm runtime remains `mecord-connect@1.0.1` under `latest` until the separately authenticated npm 2.0.0 release is published.

## Version policy

The public product/plugin version and the local npm runtime version are deliberately related but not identical:

- public product / plugin snapshot: **1.0.0**
- npm runtime currently published: **1.0.1**; next candidate: **2.0.0**

The public version tracks the stable public MCP schema/review snapshot. The The npm runtime follows independent SemVer and may advance major/minor/patch versions without forcing a public plugin version change when the public 9-tool schema/review contract itself is unchanged. Tests require the runtime candidate to be valid SemVer and never older than the actually published runtime.

## OpenAI-side state

The currently deployed Stage-1–20 software/runtime release is complete. The remaining external limitation for directory publication is OpenAI-side:

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
