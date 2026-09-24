# Mecord Connect — Current Release State

Status date: **2026-09-24**

This file is the canonical human-readable current-state summary. Machine-readable values live in `docs/release-state.json`. Older certification and gate documents may preserve historical evidence, but they must not override this file for current production facts.

## Production

- production source: `a7fd8c960a82c9565b944ffb50535eeed6989c52`
- public MCP: `https://operator.splcart.in/mcp`
- public surface: exactly **9** tools
- Developer MCP: `https://developer.operator.splcart.in/mcp`
- Developer surface: exactly **24** tools
- Developer pairing route: **404** by design
- npm: **`mecord-connect@1.0.1`** under `latest`

Live verification on 2026-09-24 confirmed both health endpoints report the same production source commit, with public toolCount 9 and Developer toolCount 24. The deployed image also rejects traversal, drive-relative, UNC and glob `git.diff` path filters before agent dispatch.

## Version policy

The public product/plugin version and the local npm runtime version are deliberately related but not identical:

- public product / plugin snapshot: **1.0.0**
- npm runtime: **1.0.1**

The public version tracks the stable public MCP schema/review snapshot. The Windows runtime may receive patch-only updates without forcing a new public plugin version. Tests must enforce the declared release-state values, matching public major/minor compatibility, and a runtime patch version that is not older than the public snapshot.

## OpenAI-side state

The software/runtime release is complete. The remaining external limitation is OpenAI-side:

- developer verification: blocked/rejected externally;
- app-directory submission: not submitted;
- live Developer ChatGPT connection: unavailable until the OpenAI verification issue is resolved.

Do not reinterpret those OpenAI-side blockers as a failure of the live public or Developer MCP servers.## Audit checkout rule

A directory name such as `Mecord-Current-Main` is not proof of revision identity. For a release audit, run the verifier from the current source and optionally point it at a separate frozen checkout:

```powershell
npm run verify:release-checkout -- "C:\\path\\to\\frozen-production-checkout"
```

If no path is supplied, it checks the current repository. The verifier compares the target checkout with the production source commit recorded in `docs/release-state.json` and requires a clean working tree. A detached HEAD is acceptable for an immutable audit snapshot when those checks pass. A newer source-successor checkout is expected to fail this production-snapshot check until that successor is actually deployed and the release-state record is updated.

## Trusted project commands

`project.commands` is intentionally empty unless the local user configures a trusted command registry. An empty registry is fail-closed behavior, not a runtime failure. The public response now reports `setupRequired: true` plus a safe setup hint when no registry is configured.
