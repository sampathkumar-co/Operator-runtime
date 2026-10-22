# Production local-model planning influence — 22 October 2026

## Scope delivered
This branch stacks on PR #361 and adds an **opt-in local planning veto**, not an unbounded AI agent.

Set `OPERATOR_TASK_ADVISOR_OLLAMA_MODEL` to an already installed local Ollama model to enable; when unset, the production `TaskOrchestrator` works as before. The planner calls the model only after an authoritative prior runtime failure/staleness/resource event. A reconcile-required event is handled conservatively without waiting for a model.

The model gets only:
- A closed enum of the last authoritative planner event `kind` and `decision`.
- The canonical risk class and two bounded numeric task-budget counters.
- Fixed instructions describing a small, closed advisory command vocabulary.

It does **not** get task objectives, action arguments or targets, paths, web content, screen images, credentials, provider error messages, or raw observation payloads. The endpoint is hard-coded to `http://127.0.0.1:11434/api/generate` with redirects disabled. Model outputs are untrusted, JSON-only, byte bounded, and timed out after 8s or the remaining task deadline, whichever is shorter.

### Allowed model responses
`ALLOW` means the existing canonical planner continues unchanged.

`REOBSERVE`, `REPLAN`, `WAIT`, or `FAIL_SAFE` can only veto the current pre-dispatch step **when the latest runtime event has exactly the matching decision**. The model cannot request reconciliation by itself; a runtime `RECONCILE` event forces a conservative stop. Unsupported model directives become `CONTROL_BLOCKED`. Supported vetoes are proposal-digest bound with `grantsAuthority:false` and `runtimeVetoRequired:true`.

This leverages the existing `TaskOrchestrator` planning influence checkpoint, existing canonical risk resolver, budget accounting, persistent evidence, authority checks, approval gates and independent verification. No model directly invokes tools or alters the durable task graph.

### Verification plan
- `node --experimental-strip-types --test test/task-local-model-planning-influence.test.ts`
- `node --experimental-strip-types --test test/task-orchestrator.test.ts test/task-async-planner.test.ts`
- `npm run typecheck:production`, `npm --prefix apps/mcp-server run check`, full MCP dependency audit.
- GitHub CI status against the exact branch SHA.

The Windows remote was unresponsive during this increment, so local tests could not be independently run on the laptop. The eight new fake-model tests exercise privacy filtering, fixed loopback origin, closed commands, authority binding, recovery hold and fail-closed timeout. **Do not count them as passed until CI or a compatible local machine reports a successful run.**

### Safety/release hold
No Ollama model installation, no remote model bill, no official MiniWoB attempt, no protected `C:\Users\SAMPATH\.operator` access, no relay restart/recovery, no merge and no deployment were performed.

Remaining major work: actual model-driven observe/choose/act planning for unfamiliar tasks with ground truth; visual fallback and computer interaction; realistic acceptance tasks; official MiniWoB++ benchmark; threat-model testing; explicit release approval and independent historical relay recovery.
