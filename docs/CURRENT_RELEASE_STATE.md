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

The repository now has a certified successor on branch `feature/windows-parity-stage4`. The runtime code was certified at commit `288d5a1c5ad5742f0f041e42740010eeda50dd92`; documentation-only commits may advance the branch head without changing that certified runtime code.

This successor is **not the production deployment yet**. Until deployment/release-state promotion occurs, the production facts above remain authoritative.

Successor changes include:

- private/Developer MCP surface expanded from **24 to 30 grouped semantic tools** while the public review-bounded surface remains **9**;
- Windows RDC-parity additions: `file.info`, `file.search`, dynamic-risk `file.manage`, interactive `terminal.session`, `process.inspect`, and fingerprinted destructive `process.manage`;
- durable Stage-4 shared-state multi-agent coordination with worker roles, dependency scheduling, work leases, resource locks/revisions, CAS blackboard state, bounded budgets, reconciliation of uncertain mutations, preemptive cancellation and verifier-gated completion;
- Control Center visibility for Stage-4 missions;
- dedicated `Windows RDC parity certification` and `Stage 4 multi-agent certification` CI gates.

The certified runtime commit passed CI #1375, Platform Matrix #1145, Windows Signing Smoke #1146, and NPM Remote Runtime CI #759 on the same immutable code head. Windows, macOS and Linux runtime regression jobs were green; Windows GUI parity is the certified desktop-control target for this successor, while Linux/macOS GUI parity remains intentionally out of scope.

## Version policy

The public product/plugin version and the local npm runtime version are deliberately related but not identical:

- public product / plugin snapshot: **1.0.0**
- npm runtime: **1.0.1**

The public version tracks the stable public MCP schema/review snapshot. The Windows runtime may receive patch-only updates without forcing a new public plugin version. Tests must enforce the declared release-state values, matching public major/minor compatibility, and a runtime patch version that is not older than the public snapshot.

## OpenAI-side state

The currently deployed software/runtime release is complete. The certified successor above still requires merge/deployment/promotion before its 30-tool Developer surface and Stage-4 runtime are live. The remaining external limitation for directory publication is OpenAI-side:

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
