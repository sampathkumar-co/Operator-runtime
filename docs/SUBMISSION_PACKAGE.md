# SPLCART Operator public plugin submission package

This document is the reviewer-facing source of truth for the public ChatGPT plugin. It intentionally describes the restricted public MCP surface, not the larger private/local Operator runtime.

## Publication identity

- Display name: **SPLCART Operator**
- Package name: `splcart-operator`
- Category: **Developer Tools**
- Initial plugin version: `0.1.0`
- Public MCP target: `https://operator.splcart.in/mcp`
- Manifest: `.codex-plugin/plugin.json`
- Machine-readable review materials: `docs/plugin-review-package.json`

The public endpoint must not be submitted until the target HTTPS origin, OAuth provider, legal/support pages, domain challenge, reviewer account, demo recording and Scan Tools snapshot are live and verified.

## What the public plugin does

SPLCART Operator lets ChatGPT work with development projects on a computer the user explicitly paired and authorized. The paired local agent remains the execution-policy boundary.

Public v1 exposes only these nine tools:

1. `computer.inspect`
2. `project.inspect`
3. `project.commands`
4. `file.list`
5. `file.read`
6. `file.create`
7. `file.replace`
8. `git.status`
9. `git.diff`

Generic terminal execution, browser automation, Windows UI Automation, arbitrary PostgreSQL row access and the legacy generic `file.write` tool are private-runtime capabilities and are **not** part of the public plugin.

## Reviewer trust model

### Local authorization still wins

OAuth and ChatGPT permission do not grant filesystem or computer authority by themselves. The paired device re-checks capability permissions, authorized roots, risk policy, emergency-stop state and one-time approvals before execution.

### Public data firewall

The public MCP boundary rejects credential-bearing paths and high-confidence restricted data before relay dispatch. Public result projection removes internal providers, evidence logs, duration telemetry, operational timestamps, internal identifiers, diagnostics and unnecessary absolute host paths.

### Safe writes have real semantics

`file.create` fails when the target already exists. `file.replace` requires the SHA-256 from a fresh read and is advertised as destructive because it overwrites existing content. A stale or missing precondition fails closed.

### Risky local approval is one-time

Approval identity is derived from the canonical action rather than a random retry UUID. A pending action can be approved locally for a bounded period, consumed exactly once, and cannot be silently replayed.

### Hosted relay retention is bounded

Acknowledged delivery payloads are erased immediately. Pending delivery payloads expire after 24 hours by default and become payload-free tombstones so stale work cannot execute later. Returned relay results expire after 24 hours by default and are physically pruned. Device release/account erasure purges remaining device-keyed deliveries, results, relay sessions and old project routing.

## OAuth and public edge

The production MCP edge requires OAuth. `operator:read` is required to connect and read-only tools use that scope. Mutating public tools additionally require `operator:write`. The MCP resource/audience remains bound to the production public URL.

The edge also provides:

- exact `/.well-known/openai-apps-challenge` domain verification;
- host/origin validation;
- per-client request throttling;
- repeated-auth-failure throttling;
- per-principal quotas;
- bounded request sizes;
- no direct Internet exposure of the local agent or relay-control API.

## Reviewer tests

The authoritative reviewer cases live in `docs/plugin-review-package.json` and must remain exactly five positive plus three negative cases.

Positive coverage:

- inspect the authorized demo project;
- read a safe source file;
- inspect Git status;
- create a previously absent safe file;
- read then replace a disposable file using the fresh SHA precondition.

Negative coverage:

- request `.env` / an API key and verify refusal before reading or relaying content;
- request a path outside the authorized project root and verify refusal;
- attempt a mutation with a read-only OAuth token and verify `operator:write` is required.

Reviewer credentials must work without MFA, SMS, email confirmation or private-network access. The review account should already have one dedicated demo device paired and one non-sensitive fixture project authorized.

## Demo recording

The submission needs a real recording from the production path. Because public v1 has no custom MCP UI, do not provide fabricated UI screenshots.

Recommended recording sequence:

1. connect the reviewer/demo account through production OAuth;
2. inspect the demo project and Git status;
3. read a safe source file;
4. demonstrate `.env` credential-path refusal;
5. create a new file;
6. read and replace the disposable fixture using the fresh SHA;
7. show a stale-SHA or missing-write-scope refusal;
8. show that the result contains task-relevant data but not internal relay/provider telemetry.

Never expose OAuth tokens, recovery credentials, device private keys, absolute personal home paths, signing material or real user data in the recording.

## Claims that must NOT be made yet

Do not claim any of the following until the external gate is actually complete:

- OpenAI marketplace/plugin approval;
- production MCP origin is live;
- successful production Scan Tools snapshot;
- production OAuth reviewer account is ready;
- business/developer identity is verified in the OpenAI Platform;
- demo recording URL exists;
- production Windows release is signed by the final trusted certificate;
- all countries/regions are supported;
- zero risk, perfect security, or guaranteed execution.

## External submission gates

Before pressing Submit for Review, verify all of these against the real deployment:

- `https://operator.splcart.in/mcp` is the permanent production HTTPS MCP origin;
- the OpenAI challenge token is served exactly at the required well-known path;
- OAuth metadata, authorization flow, PKCE/resource binding and reviewer credentials work from outside the publisher network;
- website, privacy, terms and support URLs return production content over HTTPS;
- hosted provider/region/subprocessor disclosures match the actual deployment;
- the demo recording URL is reachable by reviewers;
- Scan Tools imports exactly the intended nine-tool public surface and current annotations;
- all nine annotation justifications match the scanned server values;
- the exact five positive and three negative cases are reproducible;
- country/region availability is limited to places where support/legal obligations are ready;
- release notes describe this as the initial public submission.

## Separate Microsoft Store flow

The Microsoft Store package identity/signing flow is independent from this public MCP submission. Public-plugin hardening may require a refreshed Windows binary if local-agent code changes, but it does not require a new Store identity reservation. Keep the Store identity and Partner Center work on its existing release branch and rebuild/re-certify the final MSIX only when the local runtime changes are frozen.
