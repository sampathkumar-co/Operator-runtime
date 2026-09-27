# Architecture

## Control plane

```text
Normal ChatGPT
   |
   | MCP
   v
Hosted/public MCP transport adapter
   |
   | authenticated account/device routing
   v
Relay / control / result services
   |
   | outbound paired-device session
   v
Local Agent
   |
   +--> Policy Engine
   +--> Capability Router
   +--> Task Runtime / Evidence / Audit
   +--> Team Coordinator / Shared Blackboard
   |       +--> Worker registry + heartbeats
   |       +--> Dependency scheduler + bounded budgets
   |       +--> Work leases + artifact/resource locks
   |       +--> Revision/CAS conflict detection
   |       +--> Reconciliation + verifier gate
   +--> Computer Kernel
           +--> Filesystem search/info/manage
           +--> Process / Git
           +--> Interactive terminal sessions
           +--> Windows process inspection/management
           +--> Project model
           +--> Browser CDP
           +--> Windows UIA
           +--> Docker / PostgreSQL / VS Code adapters
           +--> Managed browser lifecycle
           +--> Vision fallback (future, only where semantic providers are insufficient)
```

## Intelligence boundary

ChatGPT owns ambiguous reasoning, interpretation, hypotheses, user dialogue and fundamentally new strategy decisions.

The runtime owns deterministic execution, bounded state gathering, retries, local waiting, verification, checkpoints, audit, capability routing and permission enforcement.

## Capability routing

Providers are scored on reliability, latency, determinism, security, reversibility, information quality and interaction cost. A native semantic provider should outrank a visual fallback for the same intent when it is available and healthy.

## Action lifecycle

```text
OBSERVE -> PLAN -> POLICY -> ROUTE -> ACT -> VERIFY -> EVIDENCE
                                  |              |
                                  +-- fallback <-+
```

A command returning successfully is not itself task completion. The postcondition must be proven.

## Task Capsules

Task Capsules are persisted independently from one ChatGPT call. They contain objective, scope, prohibited scope, success conditions, dependency nodes, evidence and failure history. Required child nodes must be verified before a task can be finalized.

This is machine-side durable state, not a claim that ChatGPT can execute indefinitely without platform invocations.

## Stage-4 team missions

Stage-4 missions are a separate durable coordination layer for multiple cooperating workers. A mission contains a dependency DAG, bounded worker/concurrency/attempt/wall-clock budgets, declared resources, resource revisions, work leases, shared blackboard entries and an append-only bounded event history.

Workers register with an explicit role and capability set. Work is claimable only when dependencies are complete, the worker role/capabilities match, concurrency budget is available and every declared resource is unlocked and certain. Mutating work holds resource locks and records base revisions; completion fails if ownership or revisions changed.

The shared blackboard is revisioned with compare-and-swap semantics so stale workers cannot overwrite newer shared state. Lease expiry is risk-aware: expired read work can return to pending, while expired mutating work becomes `NEEDS_RECONCILIATION` and its resources become uncertain. Only a supervisor or verifier can reconcile uncertain mutations.

A mission becomes `VERIFIED` only after all work completes and a verifier work item that transitively covers every non-verifier item explicitly passes verification. Mission pause/cancel and worker revocation abort active provider execution after the durable coordination transition has been persisted.

Team execution does not bypass the normal runtime. Before each worker action, the coordinator checks the exact lease, capability, canonical risk and inferred resource scope; then the existing provenance, local policy, approval, emergency-stop, provider routing and evidence/postcondition machinery remains authoritative.

## Development transport vs production transport

During development, the MCP server and local agent may run on the same computer and the MCP endpoint can be connected through OpenAI's supported secure tunneling path.

Production multi-device operation uses the relay/account layer implemented in this repository. Devices initiate outbound authenticated connections; the relay routes session-bound requests to paired devices, while the hosted MCP edge remains separate from the local desktop authority. One account may keep multiple devices paired. Routing precedence is explicit device, project binding, account default, then a uniquely eligible device. Pairing can explicitly make the new computer the account default. A configured project binding or default never silently fails over when its device is unavailable or lacks a required capability. No arbitrary inbound desktop port is required. Deployment readiness is tracked separately from architecture completion.

## Windows RDC-parity control layer

The private Windows runtime now includes bounded raw-control primitives needed when a structured application adapter is not sufficient: recursive filename search, metadata/SHA inspection, safe create/copy/move/remove operations, interactive shell-free terminal sessions, bounded process inspection and fingerprinted current-user process termination.

These primitives intentionally do not copy unrestricted remote-shell semantics. Filesystem operations remain under authorized-root and Windows path-authority protection; destructive operations use canonical risk and approval; process termination requires a fresh identity fingerprint, refuses other-user and critical Windows processes, and verifies the process identity is gone afterward. Structured Git/browser/UIA/Docker/PostgreSQL/VS Code routes remain preferred when available.
