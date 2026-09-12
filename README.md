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
- OAuth-authenticated public MCP edge mode with per-principal relay account isolation and fail-closed TLS-proxy binding
- official MCP client and MCP Inspector end-to-end certification
- Windows native launcher with bundled Node runtime and UIA sidecar
- reproducible unsigned MSIX generation and `.appinstaller` update metadata
- SignTool SHA-256 signing pipeline with publisher/certificate-subject enforcement
- ephemeral-certificate Windows install/uninstall smoke certification
- dedicated security red-team and performance-regression CI gates

The full root runtime/import suite is CI-gated alongside independent MCP transport, relay WebSocket, native Windows, MSIX packaging/sign-install, red-team, performance and cross-platform matrix checks. Exact test counts are intentionally not frozen in documentation because the suite grows with each hardened boundary.

## Remaining release gates

These are deliberately not represented as complete until their real external dependencies exist:

- production-trusted Windows code-signing identity/certificate, its SHA-256 fingerprint pinned in `operator-runtime-cli`, and RFC 3161 timestamped release signing
- publication of the signed MSIX, `release-metadata.json` and `.appinstaller` to the intended HTTPS/GitHub Release location
- publication of `operator-runtime-cli` to npm after the signer is pinned
- supported private/live ChatGPT-to-MCP certification through Secure MCP Tunnel (or the then-current supported private transport)
- deployment and live certification of the implemented OAuth-authenticated public HTTPS MCP edge if public plugin distribution is targeted
- real ChatGPT workflow against an explicitly paired physical device
- final publication/submission artwork and marketplace/store metadata
- production OAuth authorization/introspection service credentials and account integration for public multi-user deployment

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
deploy/
  public-edge/        Hardened VPS container/Compose templates for the OAuth MCP edge
src/
  core/               Policy, routing, tasks, evidence, audit, identity, relay/update state
  capabilities/       Native/semantic execution providers
security/             Red-team regression suite
performance/          Performance-regression budgets
test/                 Core security/runtime tests
docs/                 Architecture, milestones and release notes
```

## Development checks

Node 22.23.2 is pinned in CI for the current tested baseline.

```bash
npm run check
npm run test:red-team
npm run test:performance
```

The standard `npm run check` performs the root import/surface check and the full root runtime test suite.

## Windows one-command setup

For the public release, the primary onboarding command is:

```powershell
npx operator-runtime-cli setup
```

The npm bootstrap verifies bounded HTTPS release metadata, exact package size and SHA-256, a timestamped Windows signature, the package identity, and a production certificate fingerprint pinned inside the npm package before Windows installation. It refuses downgrades below its locally pinned minimum version. It then installs Operator and invokes the packaged setup, which DPAPI-protects local secrets/device identity, authorizes the invocation folder, starts the bundled local agent and MCP server, and waits for readiness.

If Operator is already installed, the equivalent local command is `operator setup`; `npx operator-runtime-cli verify` (or `operator verify`) is available for troubleshooting. Until a real production signer is pinned and the signed release plus npm package are published, the npm bootstrap intentionally fails closed instead of accepting test/unsigned builds.

To uninstall the Windows package, run `npx operator-runtime-cli uninstall`. Uninstall removes the registered MSIX but preserves local Operator state/device identity; security identity reset and revocation stay separate explicit operations rather than being hidden inside package removal.

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

A real ChatGPT deployment still requires platform-side connectivity evidence: Secure MCP Tunnel can certify the supported private/live path. For public distribution, the OAuth-authenticated MCP edge is implemented but still requires a real DNS/TLS endpoint and production OAuth service before live certification. See [`docs/PUBLIC_MCP_EDGE.md`](docs/PUBLIC_MCP_EDGE.md). Repository CI does not pretend those external gates are complete.

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
