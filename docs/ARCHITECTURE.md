# Architecture

## Control plane

```text
Normal ChatGPT
   |
   | MCP / Apps SDK
   v
MCP transport adapter
   |
   | authenticated routing
   v
Relay / secure tunnel (next milestone)
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
           +--> Windows UIA (next)
           +--> App adapters (next)
           +--> Vision fallback (later)
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

Production multi-device operation will insert a minimal relay/account layer. Devices initiate outbound authenticated connections; the relay routes signed/session-bound requests to paired devices. No arbitrary inbound desktop port is required.
