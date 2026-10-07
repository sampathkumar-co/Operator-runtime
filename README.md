# Mecord Connect — Universal Agent Runtime for ChatGPT

Operator is a semantic execution substrate for normal ChatGPT conversations to operate computers explicitly authorized by the user. The architecture prefers native APIs, structured protocols, application adapters, DOM/CDP and Windows UI Automation before pixels, and treats policy, verification, recovery, privacy and auditability as first-class execution requirements.

## Status: Stage 1–20 production live

Production is live at source `ef3bcdc2fcbc56b1b42f7a7a6f09ceabfc5a2bf2`, with the public 9-tool review surface unchanged and the private/Developer surface expanded to **36 grouped tools**. The deployed runtime includes the hardened Stage 1–20 foundation plus the certified R1 canonical runtime, R2 adaptive-planning shadow controls, and R3 Developer workstation capabilities. The npm runtime is `mecord-connect@2.0.5` under `latest`, published from the same certified source and verified by the release workflow. See [`docs/CURRENT_RELEASE_STATE.md`](docs/CURRENT_RELEASE_STATE.md), [`docs/DEVELOPMENT_PROGRESS.md`](docs/DEVELOPMENT_PROGRESS.md), [`docs/MILESTONES.md`](docs/MILESTONES.md), and [`docs/RDC_VS_MECORD_CONNECT.md`](docs/RDC_VS_MECORD_CONNECT.md).

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
- production full/private MCP runtime with **36 grouped semantic tools**
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
- Stage 5 verified procedural memory with assumption fingerprints, verifier-only promotion, invalidation/suspension and receipt-idempotent reuse outcomes
- Stage 6 evidence-backed cross-application world model with multi-source conflict preservation, freshness, verifier-committed publication and nested credential rejection
- Stage 7 authenticated paired-device resource pool with signed host resource profiles, durable capacity reservations and operation-to-device affinity
- Stage 8 organization coordinator with canary waves, bounded blast radius, explicit promotion, failure halt and compensating cleanup
- Stage 9 bounded execution optimizer that may tune strategy/concurrency only inside pre-authorized policy ceilings and cannot change authority/risk/approval
- Stage 10 governed digital operations layer with outcome contracts, explicit authority envelopes, world pre/postconditions, idempotent operation identity, verified-procedure reuse/capture, Stage-4/8 execution and final verification receipts
- grouped private MCP `operations` + `knowledge.inspect` surfaces, bringing the certified private/Developer source surface to **32 tools** while the public 9-tool surface remains unchanged
- Stage 11 multimodal perception graph with semantic/visual fusion and ambiguity fail-closed behavior
- Stage 12 bounded sandboxed JavaScript/Python compute with CPU/memory/time/image constraints
- Stage 13 durable event runtime with waits, publication, wakeups, deadlines and ticker recovery
- Stage 14 temporal world history with digest-backed transitions
- Stage 15 signed semantic continuation with destination authority/capability/resource/world/artifact proofs
- Stage 16 enterprise authority narrowing and authenticated principal propagation
- Stage 17 capability SDK contracts without ambient authority
- Stage 18 evaluation/reliability fabric
- Stage 19 verified Teach Mode plus durable, approval-aware, reconciliation-aware Studio workflow runs
- Stage 20 bounded continuous desired-state reconciliation and remediation
- local Control Center surfaces for Stage 19 Studio runs and Stage 20 desired-state contracts

The full root runtime/import suite is CI-gated alongside independent MCP transport, relay WebSocket, native Windows, MSIX packaging/sign-install, red-team, performance and cross-platform matrix checks. Exact test counts are intentionally not frozen in documentation because the suite grows with each hardened boundary.

## Remaining external gates

The certified production deployment, public 9-tool path, Developer 36-tool endpoint, and npm 2.0.5 publication are live. The remaining owner-authenticated release work is limited to OpenAI/ChatGPT plugin-directory steps:

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

Local mode talks directly to the authenticated local agent. In production, relay mode preserves the same **36-tool private MCP surface** while routing execution through the relay control authority to a paired device. The relay-control credential is restricted to a loopback control service in the certified architecture.

For private owner/developer automation, the 36-tool surface is served by the separate OAuth-authenticated **Developer MCP edge**. That edge requires the dedicated `operator:developer` scope and an explicitly entitled Mecord account; the relay still intersects device-advertised capabilities with signed session-token scopes and independently rejects non-entitled Developer dispatches. The public ChatGPT app remains the separate 9-tool surface.

The OAuth-authenticated public MCP edge is live at the production endpoint, and a fresh ChatGPT OAuth reconnect imports the canonical nine-tool surface. The separate Developer endpoint reports exactly 36 grouped tools. The Developer endpoint intentionally does not expose the pairing route. See [`docs/PUBLIC_MCP_EDGE.md`](docs/PUBLIC_MCP_EDGE.md) and [`docs/CURRENT_RELEASE_STATE.md`](docs/CURRENT_RELEASE_STATE.md).

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
