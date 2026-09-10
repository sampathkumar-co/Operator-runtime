# Operator — Universal Agent Runtime for ChatGPT

Operator is a semantic execution substrate for normal ChatGPT conversations to operate computers explicitly authorized by the user. The architecture prefers native APIs, structured protocols, application adapters, DOM/CDP and Windows UI Automation before pixels, and treats policy, verification, recovery, privacy and auditability as first-class execution requirements.

## Status: Milestone M5 — publication hardening

The execution kernel, browser kernel, Windows semantic kernel, development adapters and relay/multi-device architecture are implemented and covered by automated gates. Publication hardening is in progress.

### Implemented and CI-certified

- capability router with weighted provider selection
- local policy engine with capability, risk and path scopes
- instruction-provenance boundary for prompt-injection defense
- evidence-rich structured action results
- persistent Task Capsules and dependency gates
- rooted filesystem provider with realpath/symlink escape defense
- atomic file writes with expected-SHA protection
- argv-only process execution with no command shell and executable allowlists
- Git read/write, checkpoint, restore and transaction rollback primitives
- semantic project inspection and trusted project-command registry
- build/test artifact postcondition verification
- persistent Chromium CDP target sessions
- semantic browser inspect/navigate/click/type/select operations
- same-origin iframe/open-shadow-root traversal and bounded cross-origin CDP child sessions
- bounded browser console/runtime/network diagnostics
- browser discovery/recovery for supported Chrome/Edge installations
- native Windows UI Automation sidecar with semantic control patterns and bounded fallback routing
- VS Code, Docker and read-only PostgreSQL adapters
- authenticated loopback local-agent boundary
- emergency execution stop with separate recovery authority
- privacy inventory/purge controls for Operator-owned state
- redacting structured audit log and bounded companion read surfaces
- persistent Ed25519 device identity, pairing, revocation and short-lived relay tokens
- account-scoped multi-device registry, deterministic routing and project-to-device binding
- durable relay delivery/ACK/reconnect semantics
- real WebSocket relay server and production relay client
- MCP HTTP server with **22 semantic tools**
- local and relay-backed MCP execution modes with unchanged tool schemas
- official MCP client and MCP Inspector end-to-end certification
- Windows native launcher with bundled Node runtime and UIA sidecar
- reproducible unsigned MSIX generation and `.appinstaller` update metadata
- SignTool SHA-256 signing pipeline with publisher/certificate-subject enforcement
- ephemeral-certificate Windows install/uninstall smoke certification
- dedicated security red-team and performance-regression CI gates

The root runtime suite currently contains **102 tests**. Additional independent gates cover the MCP transport, relay WebSocket path, native Windows UIA code, Windows MSIX packaging/sign-install mechanics, red-team cases, performance budgets and the cross-platform runtime matrix.

## Remaining release gates

These are deliberately not represented as complete until their real external dependencies exist:

- production-trusted Windows code-signing identity/certificate and timestamped release signing
- supported public HTTPS update host using the final release identity
- Secure MCP Tunnel / supported public ChatGPT-to-MCP reachability test
- real ChatGPT workflow against an explicitly paired physical device
- final publication/submission artwork and marketplace/store metadata
- upstream production account/auth integration, if public multi-user relay service is deployed

The CI signing smoke uses an **ephemeral test certificate only**. It proves package/sign/install mechanics; it is not a substitute for production trust.

## Repository layout

```text
apps/
  local-agent/        Local machine enforcement + execution boundary
  mcp-server/         ChatGPT/MCP transport adapter
  relay-server/       Account/device relay authority and control boundary
native/
  windows-uia/        Native Windows UI Automation sidecar
  windows-launcher/   Packaged Windows launcher
packaging/
  windows/            MSIX build/sign/update scripts
src/
  core/               Policy, routing, tasks, evidence, audit, identity, relay/update state
  capabilities/       Native/semantic execution providers
security/             Red-team regression suite
performance/          Performance-regression budgets
test/                 Core security/runtime tests
docs/                 Architecture, milestones and release notes
```

## Development checks

Node 22.22.1 is pinned in CI for the current tested baseline.

```bash
npm run check
npm run test:red-team
npm run test:performance
```

The standard `npm run check` performs the root import/surface check and the full root runtime test suite.

## Windows one-command setup

The packaged Windows release exposes the `operator` command. From the project folder you want to authorize, run:

```powershell
operator setup
```

That single setup command generates the local-agent and recovery secrets, protects them with Windows DPAPI CurrentUser, initializes the device identity, authorizes the invocation folder, and runs the packaged verification checks. It does not print plaintext secrets. It also starts the bundled local agent and MCP server and waits for both to become healthy before returning. `operator verify` remains available as an optional re-check/troubleshooting command rather than a mandatory setup step. After `operator setup` passes, connect Operator through the supported ChatGPT MCP transport.

For development from source, the lower-level environment-variable flow remains available below.

## Run the local agent from source

Set a secret token of at least 32 characters and authorize only the roots you intend Operator to access.

```bash
export OPERATOR_AGENT_TOKEN='replace-with-a-long-random-secret'
export OPERATOR_ALLOWED_ROOTS='/path/to/project'
npm run dev:agent
```

The local agent is **loopback-only**: startup rejects wildcard, LAN, DNS-name, and other non-literal-loopback bind hosts. Remote ingress must go through the approved relay/Secure MCP Tunnel boundary; the agent is intentionally **not** a public shell endpoint.

## MCP development adapter

From `apps/mcp-server`:

```bash
npm install
export OPERATOR_AGENT_TOKEN='same-secret-as-local-agent'
npm run dev
```

Local mode talks directly to the authenticated local agent. Relay mode preserves the same 22-tool MCP surface while routing execution through the relay control authority to a paired device. The relay-control credential is restricted to a loopback control service in the certified architecture.

A real public ChatGPT deployment still requires a supported secure external reachability mechanism and the final production trust configuration; CI does not pretend those external gates are complete.

## Windows package model

The Windows release builder produces a self-contained MSIX payload containing:

- `Operator.exe` native launcher
- bundled `node.exe`
- Operator runtime/source closure required by the local agent
- bundled MCP server and locked production dependency graph
- protected one-command bootstrap CLI and `operator.exe` execution alias
- native Windows UIA sidecar
- MSIX manifest/assets
- HTTPS `.appinstaller` metadata
- SHA-256 release metadata

CI builds and unpacks the unsigned package, verifies its required payload and hash metadata, then separately builds a matching-publisher package with an ephemeral code-signing certificate, signs it, verifies it, installs it, runs the packaged launcher self-test plus the `setup -> verify -> agent/MCP health` onboarding smoke, uninstalls it and removes temporary trust material.

## Core rule

Before every capability is added, ask:

1. Is there a native API?
2. A structured protocol?
3. An application-specific interface?
4. A browser/DOM interface?
5. An OS semantic interface?
6. A safe process/API route?
7. Only then: pixels?

Then define the expected postcondition, evidence, permission boundary and recovery path before exposing the capability.
