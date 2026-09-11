# Live ChatGPT Certification Procedure

This procedure covers the remaining external M1 gate after repository CI is green. It is intentionally separate from local/MCP/relay CI because only a real supported ChatGPT connection can prove the final product path.

## Preconditions

Do not begin the certification run until all of the following are true:

- the intended ChatGPT workspace/account supports the required MCP capability level
- Developer mode / custom MCP app access is enabled where required
- a supported Secure MCP Tunnel or other officially supported remote MCP reachability mechanism is available
- Operator's MCP server remains private/local according to the supported tunnel design rather than being casually exposed as an unauthenticated public service
- the Windows release build under test is installed on the dedicated demo machine
- the demo device is paired and online
- only non-sensitive demo projects/data are authorized
- emergency-stop recovery authority is available out of band

Current OpenAI product guidance states that ChatGPT connects to remote MCP servers, not directly to local MCP servers; private/local servers should use Secure MCP Tunnel. Product availability and permission behavior can change, so re-check the official OpenAI developer/help documentation immediately before the release run.

## Test environment record

Record these values in the certification receipt without including secrets:

- date/time in UTC
- Operator commit SHA
- Windows package version
- signed MSIX SHA-256
- MCP tool-surface fingerprint/count from `npm run certify:local`
- ChatGPT plan/workspace type used for the test
- ChatGPT client surface (web/desktop)
- device public identifier/display label
- logical project key
- tunnel/connection type
- whether the test is read-only or includes write/modify capability

Never record bearer tokens, relay-control credentials, OAuth tokens, private keys, PFX material or database passwords.

## Local preflight ? required before opening the tunnel

From `apps/mcp-server`, with the authenticated local agent and loopback MCP server running, execute:

```bash
npm run check
npm run certify:local
```

The preflight must PASS before Gate A. Retain its secret-free JSON output with the release evidence. It verifies the loopback-only MCP endpoint, enumerates the canonical tool manifest, requires complete MCP safety annotations, computes a deterministic SHA-256 fingerprint over names/annotations/input schemas, and executes a real `computer.inspect` read probe through MCP. Tool-name drift or a missing annotation fails closed.

The receipt intentionally records `secureMcpTunnel` and `realChatGPTReadWorkflow` as `NOT_RUN`; local automation must never claim those external gates.

## Gate A — transport connection

Success criteria:

1. ChatGPT connects through the supported remote/tunnel path.
2. Operator's MCP server completes protocol initialization.
3. ChatGPT can enumerate the expected Operator tool surface.
4. No direct public unauthenticated local-agent endpoint is introduced to make the test work.

Evidence to retain:

- ChatGPT app/connector connected state
- bounded Operator transport log showing initialization without secrets
- tool count/names captured from the connected session

## Gate B — real read workflow

From the real ChatGPT conversation, request a harmless semantic inspection such as inspecting the paired computer or a known demo project.

Success criteria:

1. The request originates in the ChatGPT session.
2. The MCP layer creates a ChatGPT-provenance Operator action.
3. Relay routing selects the intended paired device when relay mode is used.
4. The local agent executes the read capability.
5. ChatGPT receives a structured successful result with evidence.
6. Returned data is bounded and contains no private device key material or credentials.

This closes the M1 `real ChatGPT read workflow test` gate.

## Gate C — local policy denial

Request a prepared action that is classified external or destructive without the necessary local approval.

Success criteria:

1. ChatGPT is able to request the semantic action through the connected app when the account/workspace supports that capability.
2. The local policy layer denies the action before the underlying side effect.
3. ChatGPT receives a structured failure such as `APPROVAL_REQUIRED`.
4. Independent verification confirms the marker/side effect was not created.

This demonstrates that transport or ChatGPT-side permission does not replace local Operator policy.

## Gate D — verified mutation

Only on a disposable demo repository, run the prepared trusted local write/build workflow.

Success criteria:

- a checkpoint is created before the mutation where required
- the allowed semantic mutation occurs
- the trusted verification command runs shell-free through the registered command definition
- required artifacts/postconditions pass
- ChatGPT receives the verified result/evidence

Do not use personal repositories or production infrastructure for this certification step.

## Gate E — false-green rollback

Run the prepared transaction fixture whose command exits zero but deliberately fails artifact validation.

Success criteria:

- Operator does not treat zero exit as success
- artifact verification fails
- the Git-scoped transaction restores the checkpoint
- repository state is clean/equivalent to the captured pre-state
- ChatGPT receives the structured rollback result

## Gate F — emergency stop

1. Engage Operator's emergency execution stop.
2. From ChatGPT, issue a harmless capability request.
3. Confirm execution is refused.
4. Restart the local agent if part of the planned demonstration and confirm the stop persists.
5. Clear using the separate recovery authority.
6. Confirm a subsequent harmless read succeeds.

The recovery credential must never be supplied to ChatGPT or included in MCP action arguments.

## Gate G — deterministic multi-device routing

If two paired devices are available:

1. bind the demo project key to one device
2. make both devices online where possible
3. request the project action from ChatGPT
4. verify the bound device executes it
5. take the bound device offline and verify Operator fails closed rather than silently routing the project to the other device

If only one physical device is available at release time, retain the existing automated multi-device routing certification and mark this live demonstration as not performed rather than fabricating a second device.

## Final receipt

Create a release receipt containing only non-secret evidence:

```text
Operator live certification
Commit: <sha>
Package: <version>
MSIX SHA-256: <hash>
ChatGPT surface: <surface>
Workspace capability: <read-only or full MCP>
Connection: <Secure MCP Tunnel / supported mechanism>
Device: <public demo label>
Project key: <logical key>

Transport: PASS/FAIL
Tool enumeration (<count>, SHA-256 <fingerprint>): PASS/FAIL
Real read workflow: PASS/FAIL
Local policy denial: PASS/FAIL/NOT AVAILABLE ON PLAN
Verified mutation: PASS/FAIL/NOT AVAILABLE ON PLAN
False-green rollback: PASS/FAIL/NOT AVAILABLE ON PLAN
Emergency stop: PASS/FAIL
Live multi-device deterministic route: PASS/FAIL/NOT RUN
No secrets in captured evidence: PASS/FAIL
```

## Milestone update rule

Only after Gate A and Gate B pass may these M1 items be checked:

- Secure MCP Tunnel test
- real ChatGPT read workflow test

Write/modify demonstrations are additional publication evidence and must not be claimed if the ChatGPT account/workspace used for testing does not support full MCP write/modify actions.
