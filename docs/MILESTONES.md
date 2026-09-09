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

M0 transport certification now runs the official MCP v2 client through the real Operator HTTP MCP server and real authenticated local agent. A native `computer.inspect` request must return structured evidence, while an external-risk `browser.interact` request must be stopped by the local policy layer with `APPROVAL_REQUIRED` before browser execution.

## M1 — browser kernel + secure ChatGPT dev loop — CURRENT

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

## M3 — development adapter suite — IN PROGRESS

- [x] Git write/checkpoint/restore
- [ ] VS Code adapter
- [ ] Docker adapter
- [ ] PostgreSQL structured client
- [x] project command registry
- [ ] build/test artifact validators
- [ ] checkpoint/rollback engine

Git development operations are end-to-end certified through the MCP surface. `git.checkpoint` stores separate index/worktree trees without moving HEAD, requires a fresh SHA-256 repository fingerprint for restore, creates automatic recovery checkpoints, rejects moved HEAD/stale state, and preserves staged/unstaged/untracked distinctions. `git.write` exposes only stage/unstage/commit, requires the same fresh-state precondition, creates a checkpoint before every write, rejects pathspec magic/root escapes, disables repository hooks and commit signing, and verifies commit parent/tree postconditions. Repository-local clean/smudge/process filters are fail-closed before checkpoint operations; an adversarial test proves a configured executable filter never runs.

Trusted project commands are also end-to-end certified through the 16-tool MCP surface. Repository manifests and in-project registry files are observational only and cannot grant execution authority. Runnable commands come exclusively from a bounded Operator registry stored outside all authorized project roots; executable allowlists, cwd/argv/timeout bounds and exact risk binding are enforced. The action risk seen by local policy and the caller's expected risk must both match the trusted registry. CI proves a trusted read command executes shell-free and an external trusted command is blocked by `APPROVAL_REQUIRED` before its marker file can be created.

## M4 — relay + multi-device

- account/device registry
- signed pairing challenge
- outbound persistent connection
- short-lived session tokens
- rotation/revocation
- device routing
- project-to-device resolution
- reconnect/resume

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
