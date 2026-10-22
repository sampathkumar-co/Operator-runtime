# Production local-model task proposals — 2026-10-22

This is an **isolated draft increment** stacked on `feature/production-autonomy-contract-20261022` (PR #360). It does not change the original protected relay, run a model in production, or complete the general-purpose autonomous agent.

## Capability added
The local agent supports `POST /v1/tasks/propose`, an authenticated, **proposal-only** operation. With `OPERATOR_TASK_OLLAMA_MODEL` explicitly set, the agent queries `http://127.0.0.1:11434/api/generate` using Ollama JSON mode. No arbitrary model URL, remote endpoint, bearer token, repository file content, secrets or private task journal are sent. No local model is downloaded or installed automatically.

Inputs: bounded `objective` (nonempty <=4096 chars), `approvedRoots` (subset of current device-authorized roots), and `approvedBrowserOrigins` (credential-free exact HTTP(S) origins explicitly provided by the caller). Neither list may exceed 12 entries.

Supported proposal kinds are deliberately narrow:
- `browser-navigation` with an absolute HTTP(S) URL and origin matching `approvedBrowserOrigins`.
- `trusted-project-command` with an authorized root and command kind `test`, `lint`, or `build`.

Unsupported tasks must fail rather than fabricate execution. The model response is treated as untrusted, has bounded JSON size, permits no extra fields, and cannot grant scopes or action approvals. Validation uses the current device authorization as well as the caller's explicit scopes.

## Example user-directed flow
1. Configure an already available local model through `OPERATOR_TASK_OLLAMA_MODEL=<installed-model-name>` and start the **isolated** local agent with its ordinary authorization token. The default is disabled (HTTP 503 `TASK_MODEL_NOT_CONFIGURED`).
2. Explicitly call `POST /v1/tasks/propose` with JSON:
   `{"objective":"Open the documentation at https://example.test/guide","approvedRoots":[],"approvedBrowserOrigins":["https://example.test"]}`
3. The response contains `proposal: { goal, successConditions }`, `requiresConfirmation: true`, and `executionStarted: false`.
4. Inspect that proposal; only after an explicit authorized confirmation submit the typed `goal` and `successConditions` to the existing `POST /v1/tasks` endpoint. The existing TaskOrchestrator, AgentKernel, authority and approval checks remain responsible for execution and result verification.

## Evidence
- Tests: `test/task-goal-interpreter.test.ts` cover scope denial, credential-bearing URL rejection, unsupported mutations, bounded closed command kinds, loopback-only mocked inference, authenticated proposal responses and no implicit execution.
- No live local-model inference was run during this increment. A mocked transport verifies adapter request construction, not model quality.
- Correct runtime contract/integration improvements from PR #360 remain separate.
- Local full dependency audit returned 0 vulnerabilities after upgrading the MCP server SDK and inspector. Node engine warnings were produced locally because the Windows laptop uses Node 22.14.0 while the MCP package requires Node >=22.19.0. CI uses compatible 22.23.2.

## Outstanding
Full dynamic model-based planning, grounded unknown UI interactions, durable plan synthesis, visual fallback, model cost/privacy policy acceptance, 25-task unfamiliar real-world suite, original official MiniWoB++, unblocking historic relay recovery and production certification. This proposal endpoint does **not** make the product autonomous by itself.

## Additional verification completed in this increment
- Production TypeScript compiler: `npm run typecheck:production` **PASS**.
- MCP TypeScript compiler: `npm --prefix apps/mcp-server run check` **PASS**.
- Production task/kernel/API/model proposal focused tests: **73 passed, 0 failed**.
- MCP server end-to-end suite after setting the *isolated* trusted Windows DPAPI helper: **66 passed, 0 failed, 1 skipped**. The first attempt failed only because the helper path was absent.
- `npm --prefix apps/mcp-server audit --audit-level=moderate`: **0 vulnerabilities**.
- Windows native DPAPI helper was copied solely to this isolated test worktree from the earlier RC3 reference; SHA-256 `9696E1E864AFB5CA3F9158A7AEAA03D06D59E952B0361D7784035A4D42B5E518`. The original production `.operator` state was untouched.
