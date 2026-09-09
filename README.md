# Operator — Universal Agent Runtime for ChatGPT

Operator is a semantic execution substrate for normal ChatGPT conversations to operate computers explicitly authorized by the user. The architecture prefers native APIs, structured protocols, application adapters, DOM/CDP and Windows UI Automation before pixels, and it treats verification and recovery as first-class execution requirements.

## Status: Milestone M1 — browser kernel in progress

Implemented and tested:

- capability router with weighted provider selection
- local policy engine with capability and path scopes
- instruction provenance boundary for prompt-injection defense
- evidence-rich action results
- persistent Task Capsules and dependency gates
- rooted filesystem provider with realpath/symlink escape defense
- atomic file writes with optional expected-SHA precondition
- argv-only process execution with no command shell and executable allowlist
- native Git read adapter (`status`, `diff`, `rev-parse`)
- semantic project inspection
- bounded native computer inspection
- persistent Chromium CDP target sessions
- verified direct browser navigation
- bounded semantic DOM/accessibility page inspection
- semantic browser click/type/select with postcondition evidence
- bounded browser console/runtime/network diagnostics
- internal verified tab lifecycle primitives without expanding the external tool surface
- verified browser download completion via Browser-domain CDP events
- loopback-only validation for discovered DevTools WebSocket endpoints
- authenticated loopback local-agent HTTP boundary
- redacting structured audit log
- Ed25519 device identity and challenge signing
- compact 11-tool MCP v2 surface and HTTP adapter source
- GitHub Actions gates for core tests and network-backed MCP transport typecheck

Current automated tests: **22/22 passing**.

Not yet certified:

- production relay / multi-device routing
- OAuth and account service
- Secure MCP Tunnel packaging
- iframe/shadow-DOM hardening and automatic browser discovery/launch
- Windows UI Automation kernel
- vision fallback
- application adapter SDK beyond Git
- checkpoint/rollback orchestration
- end-to-end MCP Inspector / ChatGPT invocation (GitHub CI dependency install + typecheck now passes)
- companion UI / installer / code signing

## Repository layout

```text
apps/
  local-agent/        Local machine enforcement + execution boundary
  mcp-server/         ChatGPT/MCP transport adapter
src/
  core/               Policy, routing, tasks, evidence, audit, identity
  capabilities/       Native/semantic execution providers
test/                 Security and runtime tests
docs/                 Architecture, platform matrix, milestones
```

## Run the tested kernel

Node 22+ is required for this zero-dependency development baseline.

```bash
npm test
npm run check
```

## Run the local agent

Set a secret token of at least 32 characters and authorize only the roots you intend Operator to access.

```bash
export OPERATOR_AGENT_TOKEN='replace-with-a-long-random-secret'
export OPERATOR_ALLOWED_ROOTS='/path/to/project'
npm run dev:agent
```

The local agent binds to `127.0.0.1:47100` by default. It is intentionally **not** an unrestricted public shell endpoint.

## MCP development adapter

The current MCP adapter targets the MCP TypeScript SDK v2 / 2026-07-28 protocol line. From `apps/mcp-server`:

```bash
npm install
export OPERATOR_AGENT_TOKEN='same-secret-as-local-agent'
npm run dev
```

It binds to `127.0.0.1:47200/mcp` by default. A supported secure tunnel or later authenticated relay is required for ChatGPT to reach a developer-machine MCP endpoint without exposing it directly to the public Internet.

## Core rule

Before every capability is added, ask:

1. Is there a native API?
2. A structured protocol?
3. An application-specific interface?
4. A browser/DOM interface?
5. An OS semantic interface?
6. A safe process/API route?
7. Only then: pixels?

Then define the expected postcondition, evidence, permission boundary, and recovery path.
