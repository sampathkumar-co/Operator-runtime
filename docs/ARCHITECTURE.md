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
   +--> Verified Procedure Memory
   +--> Evidence-backed World Model
   +--> Device Resource Pool / Durable Placement
   +--> Organization Rollout Coordinator
   +--> Bounded Execution Optimizer
   +--> Digital Operations Governor
   |       +--> Outcome contract + authority envelope
   |       +--> Procedure reuse/capture
   |       +--> World pre/postconditions
   |       +--> Stage-4 / Stage-8 execution
   |       +--> Verification receipt
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


## Stage-5–10 Agent OS layers

### Verified procedural memory

Procedure memory stores only procedures backed by independent verification. Reuse is scoped by objective kind, scope key, bounded assumption fingerprints and required capabilities. Procedures expire, can be invalidated, and can be suspended after repeated failed reuse. Verification and outcome receipts are idempotent so a crash/retry cannot inflate confidence or success counts.

Procedure memory is not an authority store. Remembered steps do not grant capabilities, approvals, roots or recovery authority.

### Evidence-backed world model

The world model represents entities and relations across browser, applications, files, Git, databases, processes, projects, devices and organizations. Each fact is a set of source/evidence claims with confidence and expiry rather than a mutable single truth slot. Conflicts remain explicit unless a clearly dominant multi-source result is resolved.

Normal agent world writes are verifier-only. A passing Stage-4 verifier commits the exact world-observation payload digest into its durable result before publication. Re-publication must match that commitment. Nested secret-bearing structures and obvious credential strings are rejected.

### Trusted device resource pool

Devices advertise CPU/memory/GPU/tag/concurrency metadata inside the signed relay hello. The relay builds resource advertisements only from active paired/account-owned sessions. The scheduler then filters by authenticated capability support and bounded resource requirements.

Long-running Stage-10 operations hold a durable device reservation for the operation lifetime. The operation UUID is bound to one device, reservation renewal survives retries/reconnects, and terminal VERIFIED/FAILED/CANCELLED results release capacity.

### Organization execution

The organization coordinator compiles many target scopes into Stage-4 missions. Rollout is canary/wave based with explicit scope prefixes, bounded parallelism and verified promotion between waves. Failures halt expansion. Startup/resume transitions have compensating rollback so partially created or resumed missions are not left running if the organization state cannot be committed.

### Bounded execution optimization

The optimizer ranks only caller-authorized strategies and can recommend bounded concurrency changes inside explicit caller policy floors/ceilings. Learned adjustments are intentionally small. The optimizer never modifies capability authority, canonical risk, scope, approval, recovery authority or verification requirements.

### Digital operations governor

Stage 10 composes the layers above under a durable outcome contract.

A contract may provide an explicit Stage-4/Stage-8 execution graph, or request bounded outcome auto-planning. Auto-planning always requires an explicit **authority envelope** containing a requested capability subset and exact Stage-4 resource keys. The runtime intersects the requested capabilities with locally allowed capabilities, so the envelope can restrict but never grant authority. The default planning risk is read; dynamic-risk capabilities are excluded from auto-planning.

The operation has a stable UUID and canonical submission digest. Duplicate submit of the same UUID+contract returns the existing operation; reuse of the UUID with a different contract fails closed.

Final verification requires both the underlying Stage-4/Stage-8 verifier state and declared world postconditions. Procedure capture uses the operation verification receipt plus actual verifier evidence. Optimizer/procedure learning uses deterministic receipts so repeating finalization after a crash is idempotent.

## Private MCP surface

The Stage-1–10 successor keeps the public review-bounded 9-tool surface unchanged. The private/Developer source surface is **32 grouped tools**. Two grouped tools expose the new Agent-OS layer:

- `operations`: submit/inspect/start/refresh/pause/cancel/promote durable Stage-10 operations;
- `knowledge.inspect`: read-only verified procedure/world/optimizer inspection.

Stage-5–10 internals are not exposed as a collection of raw authority-bearing tools. Device placement, organization rollout mechanics, learning and world publication remain governed by their internal trust boundaries.
