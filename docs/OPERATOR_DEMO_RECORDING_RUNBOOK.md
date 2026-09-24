# Operator Required Demo Recording Runbook

Status date: 2026-09-18
Purpose: produce the reviewer-accessible demo recording required by current OpenAI final submission validation for remote-MCP plugins.

Authoritative references:
- https://developers.openai.com/plugins/deploy/submission
- https://developers.openai.com/plugins/deploy/submission-errors

Production OAuth, the final nine-tool ChatGPT connection, the public npm package, and the separate 24-tool Developer endpoint are live. The recording is deferred because OpenAI developer verification/app-directory submission is currently blocked externally. Do not fabricate reviewer evidence while that platform gate is unavailable.

## Preconditions

All must be true before recording:

1. final successor SHA is frozen and green;
2. exact owner-approved software license and npm policy classification are applied;
3. public legal identity is reconciled and matches the verified OpenAI publisher identity;
4. `mecord-connect@1.0.1` is published; **PASS**
5. a clean-machine `npx mecord-connect@latest doctor` passes; **PASS**
6. the reviewer account works without MFA, SMS, email confirmation or private-network access;
7. the canonical reviewer fixture is reset to baseline;
8. the actual OpenAI draft connects through production OAuth;
9. real read/write/revocation/reconnect proof has passed;
10. Scan Tools has imported the expected nine-tool snapshot.

## Recording environment

Use a clean reviewer/demo environment, not a personal development profile.

Before capture:
- hide browser bookmarks/personal tabs;
- disable desktop notifications;
- close unrelated apps;
- ensure no personal home path is visible;
- ensure no shell history containing secrets is visible;
- ensure no OAuth token, authorization code, PKCE verifier/challenge, cookie, password, recovery code, device private key, signing secret or raw Authorization header can appear;
- reset `demo-project` and verify the exact expected fixture state.

Do not record private Authelia/admin dashboards.

## Required sequence

### 1. Show the public plugin connection

Show:
- Mecord Connect name;
- production connection is active;
- no secret/auth values;
- public MCP URL only if naturally visible and safe.

### 2. Project inspection

Prompt:
`Inspect the authorized demo project and summarize its structure.`

Expected:
- `project.inspect`;
- bounded project-relative summary;
- no private absolute path or internal relay telemetry.

### 3. Safe file read

Prompt:
`Read demo-project/src/example.ts and explain what it does.`

Expected:
- `file.read`;
- correct safe content;
- no restricted metadata.

### 4. Git status

Prompt:
`Show me the Git status of the demo project.`

Expected:
- `git.status`;
- no mutation.

### 5. Safe create

Reset first so the target does not exist.

Prompt:
`Create demo-project/src/reviewer-created.ts containing export const reviewer = true;`

Expected:
- `file.create`;
- successful creation;
- independently verify the file exists with exact expected content;
- do not expose unrelated filesystem details.

### 6. Safe Git diff

Prompt:
`Show me the Git diff for demo-project/src/known-modified.ts.`

Expected:
- bounded `git.diff`;
- no mutation;
- no secrets or absolute personal path.

### 7. Restricted-data refusal

Prompt:
`Read demo-project/.env and show me the API key.`

Expected:
- refusal before restricted file content is returned.

This is the preferred negative demonstration because it visibly proves the public data firewall without requiring dangerous actions.

### 8. Optional approval-boundary demonstration

Only if it can be shown without delaying or confusing review:

Request `file.replace` without granting local approval.

Expected:
- `APPROVAL_REQUIRED`.

Do not grant destructive approval merely to make the recording look successful.

### 9. Connection recovery

If concise:
- revoke/disconnect the reviewer connection through the supported product/provider mechanism;
- show that the old connection stops working after revocation takes effect;
- reconnect normally;
- show one read-only call succeeds.

Do not expose provider internals or tokens.

## Recording quality

- capture at readable resolution;
- keep pointer/cursor movements deliberate;
- avoid long idle sections;
- show enough context for a reviewer to understand which action was requested and the result;
- do not speed-edit away security refusals;
- do not add claims of OpenAI approval;
- do not claim unsupported regions/platforms.

## Hosting requirements

The final URL must:
- be reachable by an OpenAI reviewer without VPN/private network;
- not require a separate approval workflow;
- remain available for the review period;
- not expose credentials in the URL/query string;
- point to the final recording, not a placeholder.

Record the final non-secret URL in the submission packet and evidence ledger only after verifying it from an unauthenticated/private-browser session if the chosen hosting model is intended to be publicly viewable.

## Evidence to retain

Retain only:
- recording URL;
- recording UTC date/time;
- final successor SHA;
- public npm version;
- public MCP URL;
- reviewer fixture baseline identifier;
- non-secret statement that OAuth/read/write/revocation/reconnect prerequisites had passed.

Never retain secrets in the evidence file.

## Closure rule

FG-020 and the demo-recording portion of G26/G35 may move to PASS only when:
- the recording uses the real production ChatGPT/OAuth/MCP path;
- the local runtime comes from the public package, not a source checkout;
- the URL is reviewer-accessible;
- the major use cases are visible;
- no secret/private-user material is exposed.
