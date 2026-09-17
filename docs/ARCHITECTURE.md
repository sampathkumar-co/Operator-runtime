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
   +--> Computer Kernel
           +--> Filesystem
           +--> Process / Git
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

## Development transport vs production transport

During development, the MCP server and local agent may run on the same computer and the MCP endpoint can be connected through OpenAI's supported secure tunneling path.

Production multi-device operation uses the relay/account layer implemented in this repository. Devices initiate outbound authenticated connections; the relay routes session-bound requests to paired devices, while the hosted MCP edge remains separate from the local desktop authority. No arbitrary inbound desktop port is required. Deployment readiness is tracked separately from architecture completion.
