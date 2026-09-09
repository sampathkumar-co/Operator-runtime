# Milestones

## M0 — execution kernel foundation — COMPLETE

Acceptance gates:

- [x] compact action/result protocol
- [x] capability router
- [x] local capability permission checks
- [x] instruction provenance enforcement
- [x] evidence objects
- [x] persistent Task Capsules
- [x] native filesystem with scope enforcement
- [x] argv-only process execution
- [x] Git read adapter
- [x] semantic project inspection
- [x] browser CDP discovery
- [x] local-agent bearer authentication
- [x] redacting audit log
- [x] device identity signing
- [x] security tests
- [x] initial MCP v2 adapter source
- [x] MCP adapter dependencies installed and end-to-end tested

M0 transport certification runs the official MCP v2 client through the real Operator HTTP MCP server and real authenticated local agent. Native inspection returns structured evidence while risky actions must be stopped by the local policy layer before execution when approval is absent.

## M1 — browser kernel + secure ChatGPT dev loop — EXTERNAL GATES PENDING

- [x] persistent CDP target session manager
- [x] connect to existing Chrome/Edge through configured loopback CDP
- [x] internal new-tab creation primitive
- [x] navigation with URL postcondition verification
- [x] compact DOM/accessibility representations
- [x] semantic element locate/click/type/select
- [x] bounded console/runtime-exception/network-failure capture during actions
- [x] credential-bearing and non-HTTP(S) URL rejection
- [x] internal tab focus/close primitives
- [x] download initiation and completion events
- [x] iframe/shadow-DOM strategy
- [x] browser attach/launch discovery across Chrome + Edge profiles
- [x] MCP adapter dependencies install + typecheck in GitHub CI
- [x] MCP Inspector end-to-end test
- [ ] Secure MCP Tunnel test
- [ ] real ChatGPT read workflow test

Browser semantics traverse open shadow roots and same-origin iframes in-document, plus bounded cross-origin OOPIF sessions through flattened CDP child sessions. Interactions run a locate-only preflight across all contexts and reject ambiguous multi-context matches before any side effect. Browser lifecycle recovery checks configured and previously launched endpoints, discovers verified dynamic `DevToolsActivePort` endpoints from bounded Chrome/Edge data roots without reading profile databases, then launches an isolated Operator profile only when necessary.

MCP certification is stronger than source/type checks: GitHub CI pins a compatible Node 22 release, installs MCP Inspector 2.5.0, boots the real local agent and real MCP HTTP server, runs the official MCP client through initialize/listTools/callTool, and independently runs Inspector CLI `tools/list` against the same endpoint.

## M2 — Windows semantic kernel — COMPLETE

- [x] Win32 window/process discovery
- [x] UI Automation tree inspection
- [x] Invoke/Value/Selection/ExpandCollapse/Scroll patterns
- [x] focus/window activation
- [x] event subscriptions
- [x] semantic wait-for-control
- [x] fallback routing when UIA coverage fails

Fallback is bounded and semantic: the native sidecar remains alive when UIA initialization fails, exact Win32 PID/title/class discovery and activation remain available where explicitly requested, and matched controls that lack modern Invoke/Value patterns can fall back to LegacyIAccessible default-action/value APIs. UIA-only selector fields are never approximated, arbitrary HWND input is not exposed, and unsupported operations still fail closed. This path is covered by Windows compile/tests and Clippy in CI.

## M3 — development adapter suite — COMPLETE

- [x] Git write/checkpoint/restore
- [x] VS Code adapter
- [x] Docker adapter
- [x] PostgreSQL structured client
- [x] project command registry
- [x] build/test artifact validators
- [x] checkpoint/rollback engine

Git development operations are end-to-end certified through the MCP surface. `git.checkpoint` stores separate index/worktree trees without moving HEAD, requires a fresh SHA-256 repository fingerprint for restore, creates automatic recovery checkpoints, rejects moved HEAD/stale state, and preserves staged/unstaged/untracked distinctions. `git.write` exposes only stage/unstage/commit, requires the same fresh-state precondition, creates a checkpoint before every write, rejects pathspec magic/root escapes, disables repository hooks and commit signing, and verifies commit parent/tree postconditions. Repository-local clean/smudge/process filters are fail-closed before checkpoint operations; an adversarial test proves a configured executable filter never runs.

Trusted project commands are end-to-end certified through the MCP surface. Repository manifests and in-project registry files are observational only and cannot grant execution authority. Runnable commands come exclusively from a bounded Operator registry stored outside all authorized project roots; executable allowlists, cwd/argv/timeout bounds and exact risk binding are enforced. The action risk seen by local policy and the caller's expected risk must both match the trusted registry. CI proves a trusted read command executes shell-free and an external trusted command is blocked by `APPROVAL_REQUIRED` before its marker file can be created.

Build/test artifact validators are integrated into the trusted-command path without expanding the MCP tool surface. The external registry may declare bounded project-relative artifacts with file/directory/JSON type, minimum size and optional `mustChange` requirements. Operator snapshots artifacts before execution, rejects symlink/escape tricks, verifies artifact type/size/change after execution, and parses bounded JSON reports. A zero process exit is not considered verified when artifact postconditions fail; CI proves both a successful changed JSON build artifact and a deliberate zero-exit stale-artifact false green through the real MCP/local-agent stack.

The checkpoint/rollback engine is a Git-scoped transaction layer exposed as `project.transaction`. It is always classified destructive so local policy must approve rollback authority before execution. Once approved, Operator creates a non-mutating checkpoint, runs only a trusted local read/write command, validates process and artifact postconditions, and automatically restores the checkpoint if verification fails. Provider tests prove a tracked-file mutation from a zero-exit false-green command is restored to exact clean Git state. External commands are refused because their effects cannot be honestly compensated by Git. The MCP/Inspector stack independently proves the transaction remains blocked with `APPROVAL_REQUIRED` when destructive approval is absent.

The Docker adapter is end-to-end certified through the MCP surface. `docker.inspect` accepts only local Unix-socket, Windows named-pipe, or loopback TCP Docker contexts and returns bounded daemon/container metadata without commands, environments, mounts, or arbitrary labels. Project-scoped inspection and lifecycle management do not parse repository Compose YAML; they discover already-created Compose containers from Docker-owned labels and match the recorded working directory to an authorized root. `docker.manage` exposes only start/stop/restart for named existing services, requires a fresh SHA-256 state fingerprint, re-inspects postconditions, scrubs ambient Docker context/host environment, disables automatic Compose `.env` loading, and is locally system-change gated. Builds, pulls, run/exec, down, and volume deletion remain outside this certified slice.

The PostgreSQL adapter is read-only and structured. Trusted connection profiles live outside project roots; profile discovery never returns passwords, password environment names, or raw DSNs. Only local/loopback database endpoints are permitted in the certified slice. Operator constructs SELECT/metadata SQL itself, validates identifiers, passes filter values through psql quoted-variable interpolation, disables ambient PostgreSQL connection variables and `.pgpass` fallback, and enforces server-side read-only transactions plus statement/lock timeouts and bounded output. Injection/profile-isolation tests and the real MCP profile-discovery path are green.

The VS Code adapter uses the official CLI through a closed operation set. Read-only inspection covers version, bounded status diagnostics, and installed extension IDs/versions. Project/file/goto/diff opens are locally system-change gated and always use a new Operator-isolated user-data directory outside all authorized project roots with extensions disabled. Inherited `VSCODE_*` IPC variables and `ELECTRON_RUN_AS_NODE` are removed so an invocation cannot silently reuse an existing user window. The certified adapter does not expose extension installation/removal, VS Code chat, tasks/terminal execution, URL handlers, arbitrary CLI flags, or reuse-window behavior. Provider isolation/path tests and the 22-tool MCP/Inspector policy-boundary test are green.

## M4 — relay + multi-device — IN PROGRESS

- [ ] account/device registry
- [ ] signed pairing challenge
- [ ] outbound persistent connection
- [ ] short-lived session tokens
- [ ] rotation/revocation
- [ ] device routing
- [ ] project-to-device resolution
- [ ] reconnect/resume

## M5 — companion UI and publication hardening

- Devices / Tasks / Permissions / Activity / Settings
- emergency disconnect
- installer + auto-update
- code signing
- privacy/data controls
- submission assets
- red-team suite
- performance benchmark suite
- final platform-matrix revalidation
