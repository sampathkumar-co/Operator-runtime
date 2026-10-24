# Mecord Connect source-derived capability and release matrix

**Status:** 2026-10-24. **Published npm stable runtime:** `mecord-connect@2.0.6` from source `b9682da964b8dfcda9b4ce65e1ba6352623bf7a5`. **Developer candidate source:** moving repository `main` (not an npm release). This report describes code-declared tools and known caveats; it is **not** a claim that the installed device, hosted connector, browser, native helper or any individual user session currently supports every operation.

## Public nine-tool contract

Source of truth: `src/core/public-plugin-surface.ts` and registration in `apps/mcp-server/src/public-tools.ts`.

| Public tool | Declared purpose | Boundary |
| --- | --- | --- |
| `computer.inspect` | Inspect basic authorized computer capability and platform state | Read-only, no secret/computer-file access implied |
| `project.inspect` | Bounded authorized project inspection | Requires authorized project root |
| `project.commands` | Inspect approved registered project commands | Lists only; does **not** execute them |
| `file.list` | List authorized project directory | Read and scope/secret-path checks |
| `file.read` | Bounded authorized UTF-8 file read | Secret-bearing paths refused |
| `file.create` | Create a new bounded UTF-8 project file | Refuses overwrite; write scope required |
| `file.replace` | Replace existing file with exact SHA-256 precondition | Destructive-risk approval still required |
| `git.status` | Bounded authorized Git status | Read-only, repository scope checked |
| `git.diff` | Bounded literal-file Git diff | Rejects glob/magic, traversal and secret paths |

The published public tool contract is deliberately narrower than the local runtime's underlying canonical capability registry. The public plugin does **not** publish arbitrary terminal, Docker, database-writing, browser-control or native input tools.

## Private Developer surface (not public permissions)

Source of truth: `apps/mcp-server/src/tool-surface.ts`, `src/core/capability-policy.ts`, registered runtime providers and current session authority. Selected additional private operations include `task.submit`, `task.control`, `project.command`, `project.transaction`, `workspace.edit`, `file.manage`, `git.checkpoint`, `git.write`, `docker.inspect`, `docker.manage`, `postgres.query`, `vscode.inspect`, `terminal.execute`, `terminal.session`, `browser.inspect`, `browser.interact`, `app.inspect` and `app.operate`.

This is a representative source-declared list, not a promise that each operation is presently advertised or granted. The Developer surface uses independent account/device/session state, local policy, scope, canonical risk and approval. `app.operate` and external/destructive actions must not gain approval from Control Center browser login or model-generated text.

## Platform and feature evidence

| Feature | Source/platform constraint | Certification state |
| --- | --- | --- |
| Filesystem and Git | Requires explicitly authorized roots, bounds, stable path identity; some write actions need approval | CI fixtures exist; original device acceptance varies |
| Browser DOM/CDP | Requires configured authorized loopback Chromium-compatible browser/target; unsupported and inaccessible pages must report errors | Model-neutral CI fixtures only for new Wave 0 checks; real Chrome/Edge journeys not certified here |
| Windows UI Automation / native process controls | Windows-specific helper, desktop/session/window identity, stop/cancellation and exact process ownership | Windows source CI exists; production physical acceptance not established by it |
| Project / Docker / PostgreSQL / VS Code | Provider configuration, command/profile allowlists and operation-specific policy; PostgreSQL public Developer query is read-only | Source/CI contracts exist; live deployment acceptance separate |
| Multi-step task model assistance | Optional model/provider, budget, approval, independent goal verification and zero unsafe replay | No independently scored full three-lane campaign accepted |
| Control Center browser sign-in | Source integrated at stable 2.0.6 convergence #373; browser session must not become native recovery authority | Source integrated; original-device / hosted browser acceptance not certified |
| Historical receipt recovery | Quarantine and independent exact authority required; do not acknowledge/replay or delete uncertain receipts | Original-device physical acceptance DEFERRED / NOT VERIFIED |

## Release-truth boundary

`src/core/release-truth.ts` and `docs/release-state.json` deliberately maintain a separately attested production deployment record; it may lag the npm package and development `main`. Do not silently rewrite these fields to 2.0.6 merely because npm 2.0.6 exists. The frozen npm registry tarball SHA-256 independently measured in Wave 0 was `de8a4d8435970fd9a75c74b17c8e7f0b02d595cf7aed440cfaf01ec1d9b9db9c` (GitHub Actions run 40104325858). This attests public bytes, not runtime success or reproducible source build equivalence.

**Release candidate acceptance: NOT ACCEPTED.** The exact model/controller, held-out evaluations, original Windows machine, independent cross-host recovery, canary and owner publication decision remain separate gates under issues #374 and #386. No npm or hosted production update is authorized by this documentation.
