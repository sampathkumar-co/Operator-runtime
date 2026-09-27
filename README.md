# Mecord Connect — Universal Agent Runtime for ChatGPT

Operator is a semantic execution substrate for normal ChatGPT conversations to operate computers explicitly authorized by the user. The architecture prefers native APIs, structured protocols, application adapters, DOM/CDP and Windows UI Automation before pixels, and treats policy, verification, recovery, privacy and auditability as first-class execution requirements.

## Status: production v1 live; Windows RDC-parity + Stage-4 successor certified

The currently deployed production release remains source `94becbf734817121fbea1a017b9e1b10c144d125`, with exactly 9 public tools, 24 deployed Developer tools and `mecord-connect@1.0.1` under `latest`. A newer source successor on `feature/windows-parity-stage4` has completed Windows RDC-parity and Stage-4 shared-state multi-agent certification; its runtime code was certified at `288d5a1c5ad5742f0f041e42740010eeda50dd92` and expands the private/Developer source surface to 30 grouped semantic tools while leaving the public 9-tool surface unchanged. That successor is not production until it is merged/deployed and release-state metadata is promoted. See [`docs/CURRENT_RELEASE_STATE.md`](docs/CURRENT_RELEASE_STATE.md), [`docs/MILESTONES.md`](docs/MILESTONES.md), and [`docs/RDC_VS_MECORD_CONNECT.md`](docs/RDC_VS_MECORD_CONNECT.md).

### Implemented and CI-certified

- capability router with weighted provider selection plus bounded context-specific reliability/latency learning that can tune ranking but never permissions or risk
- local policy engine with capability, risk and path scopes
- instruction-provenance boundary for prompt-injection defense
- evidence-rich structured action results
- persistent Task Capsules and dependency gates
- durable semantic task executor with cross-process ownership, bounded typed multi-goal workflows, retries, loop detection, preemptive cancellation, pause/resume, crash recovery and evidence-backed postconditions
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
- source-successor full/private MCP runtime with **30 grouped semantic tools**; currently deployed production Developer endpoint remains 24 until successor deployment
- curated public Mecord Connect MCP surface with **9 review-bounded tools**; generic terminal, browser/UIA automation and arbitrary database-row access remain private-only
- local and relay-backed private MCP execution modes with unchanged full-runtime tool schemas
- OAuth-authenticated public MCP edge mode with per-principal relay account isolation and fail-closed TLS-proxy binding
- official MCP client and MCP Inspector end-to-end certification
- Windows native launcher with bundled Node runtime and UIA sidecar
- reproducible unsigned MSIX generation and `.appinstaller` update metadata
- SignTool SHA-256 signing pipeline with publisher/certificate-subject enforcement
- ephemeral-certificate Windows install/uninstall smoke certification
- dedicated security red-team and performance-regression CI gates
- Windows RDC-parity layer with bounded file search/info/manage, interactive terminal sessions, process inspection and fingerprinted current-user process termination
- durable Stage-4 team coordinator with worker leases, dependency scheduling, resource locks/revisions, CAS blackboard state, bounded budgets, reconciliation, cancellation and verifier-gated completion
- dedicated Windows RDC parity and Stage 4 multi-agent certification CI gates

The full root runtime/import suite is CI-gated alongside independent MCP transport, relay WebSocket, native Windows, MSIX packaging/sign-install, red-team, performance and cross-platform matrix checks. Exact test counts are intentionally not frozen in documentation because the suite grows with each hardened boundary.

## Remaining external gates

The existing production deployment, npm publication, public 9-tool path and deployed 24-tool Developer endpoint are complete. The certified 30-tool/Stage-4 successor still requires merge/deployment/promotion before it becomes the live production runtime. OpenAI directory work remains external:

- resolve OpenAI individual/developer verification;
- create/attach the separate Developer ChatGPT connection after verification becomes available;
- perform any portal-only Scan Tools/reviewer/demo steps required for app-directory submission;
- submit to the OpenAI app directory only after verification succeeds and the owner explicitly chooses to do so.

Microsoft Store/MSIX remains optional and outside Mecord Connect v1 release requirements.

The CI signing smoke uses an **ephemeral test certificate only**. It proves direct package/sign/install mechanics; it is not a substitute for production trust and is not a Microsoft Store signing prerequisite.

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

For the Mecord Connect public runtime, the primary onboarding command is:

```powershell
npx mecord-connect@latest remote --root "C:\path\to\project"
```

The runtime authorizes only the requested root, starts the secure local agent, connects to the hosted relay, and opens the normal authenticated Mecord web-pairing flow when the device is not already paired. ChatGPT uses the hosted MCP edge; users do not need to expose a local MCP server.

Before connecting, the packaged runtime can be integrity-checked with:

```powershell
npx mecord-connect@latest doctor
```

`doctor` verifies the packaged runtime payload and Windows-native security helpers without starting a relay session. The legacy `operator-runtime-cli setup/verify/uninstall` flow is not the current Mecord Connect v1 onboarding path.

For development from source, the lower-level environment-variable flow remains available below.

## Run the local agent from source

Set a secret token of at least 32 characters and authorize only the roots you intend Operator to access.

```bash
export OPERATOR_AGENT_TOKEN='replace-with-a-long-random-secret'
export OPERATOR_ALLOWED_ROOTS='/path/to/project'
npm run dev:agent
```

The local agent is **loopback-only**: startup rejects wildcard, LAN, DNS-name, and other non-literal-loopback bind hosts. Remote ingress must go through the approved relay/Secure MCP Tunnel boundary; the agent is intentionally **not** a public shell endpoint.

The authenticated local boundary also exposes durable task execution: `POST /v1/tasks` submits controlled-file-change, trusted-project-command, semantic browser-navigation, semantic app-operation, Docker lifecycle, bounded PostgreSQL SELECT, or a `semantic-workflow` containing 1–20 of those typed goals, while `POST /v1/tasks/:id/run`, `/pause`, `/resume`, and `/cancel` control them. Workflow children never become raw shell/model actions: each child is revalidated by the existing semantic planner, canonical risk resolver, local policy, approval boundary and postcondition verifier. `GET /v1/tasks/:id` returns the persisted Task Capsule, including action attempts, normalized machine observations, and evidence. The private MCP surface exposes the same durable boundary through `task.submit` and `task.control`, including relay-persisted task-to-device affinity; neither private MCP tool accepts recovery credentials or an approval action ID. Approval of a blocked action remains a separate local recovery-authority operation bound to the exact deterministic blocked action ID.

## Stage-4 multi-agent execution

The source successor adds an authenticated durable team coordinator under `/v1/teams`. It coordinates multiple external workers rather than embedding a specific LLM: workers register a role/capability set, claim dependency-ready work under a lease, operate only on declared resources, share revisioned CAS blackboard state, heartbeat while active and complete/fail/reconcile work with evidence.

Mutating work owns resource locks and base revisions. If ownership is lost or a mutating lease expires, the work becomes `NEEDS_RECONCILIATION` instead of being blindly replayed. Mission pause/cancel and worker revocation preempt active provider execution. Final mission completion requires a verifier work item that transitively covers every non-verifier work item and explicitly passes verification.

The existing provenance, canonical risk resolver, local policy, approvals, emergency stop, provider routing and postcondition verification remain authoritative underneath every team action. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and [`docs/MILESTONES.md`](docs/MILESTONES.md).
## MCP development adapter

From `apps/mcp-server`:

```bash
npm install
export OPERATOR_AGENT_TOKEN='same-secret-as-local-agent'
npm run dev
```

Local mode talks directly to the authenticated local agent. On the certified successor branch, relay mode preserves the same 30-tool private MCP surface while routing execution through the relay control authority to a paired device. The currently deployed Developer endpoint remains the older 24-tool production snapshot until successor deployment. The relay-control credential is restricted to a loopback control service in the certified architecture.

For private owner/developer automation, the successor's 30-tool surface can be served by the separate OAuth-authenticated **Developer MCP edge** after deployment. That edge requires the dedicated `operator:developer` scope and an explicitly entitled Mecord account; the relay still intersects device-advertised capabilities with signed session-token scopes and independently rejects non-entitled Developer dispatches. The public ChatGPT app remains the separate 9-tool surface.

The OAuth-authenticated public MCP edge is live at the production endpoint, and a fresh ChatGPT OAuth reconnect imports the canonical nine-tool surface. Real paired-Windows device inspection/read/Git/create paths have been proven, and the separate Developer endpoint reports exactly 24 tools. The Developer endpoint intentionally does not expose the pairing route. See [`docs/PUBLIC_MCP_EDGE.md`](docs/PUBLIC_MCP_EDGE.md) and [`docs/CURRENT_RELEASE_STATE.md`](docs/CURRENT_RELEASE_STATE.md).

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
