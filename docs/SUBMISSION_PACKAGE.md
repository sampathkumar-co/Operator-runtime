# Mecord Connect public plugin submission package

This document is the reviewer-facing source of truth for the public ChatGPT plugin. It intentionally describes the restricted public MCP surface, not the larger private/local Operator runtime.

## Publication identity

- Display name: **Mecord Connect**
- Package name: `mecord-connect`
- Category: **Developer Tools**
- Initial plugin version: `1.0.0`
- Public MCP target: `https://operator.splcart.in/mcp`
- Manifest: `.codex-plugin/plugin.json`
- Machine-readable review materials: `docs/plugin-review-package.json`

Production is live on Mecord Connect source `3b3b1bff35f8e78519f114b603f98e8acc56cd66`, and `mecord-connect@1.0.0` is public under `latest`. The fresh ChatGPT OAuth connection imports exactly the canonical nine tools with no `device.claim`. Source/legal/package metadata identifies **Kinthala Samuel Sampath Kumar**, proprietary licensing and DUAL_USE. Submission remains blocked only on the unresolved OpenAI/reviewer/device evidence: publisher verification, reviewer/device pairing, portal challenge if issued, Scan Tools, device-backed read/write + revoke/reconnect proof, demo recording, and final Submit for Review authorization.

## What the public plugin does

Mecord Connect lets ChatGPT work with development projects on a computer the user explicitly paired and authorized. The paired local agent remains the execution-policy boundary.

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

- a fail-closed `/.well-known/openai-apps-challenge` route that remains 404 until the OpenAI portal supplies an exact verification token;
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
- inspect a bounded Git diff for the known modified fixture file.

Negative coverage:

- request `.env` / an API key and verify refusal before reading or relaying content;
- request a path outside the authorized project root and verify refusal;
- attempt a mutation with a read-only OAuth token and verify `operator:write` is required.

Reviewer credentials must work without MFA, SMS, email confirmation or private-network access. The review account should already have one dedicated demo device paired and one non-sensitive fixture project authorized.

## Required demo recording

Current OpenAI final submission validation for remote-MCP plugins requires a reviewer-accessible demo recording URL showing the plugin's major use cases across supported platforms. This is **not** satisfied by screenshots, and because public v1 has no custom MCP UI, do not provide fabricated UI screenshots.

Create the recording only after the real production ChatGPT OAuth/reviewer path works from the public package. Use this sequence:

1. connect the reviewer/demo account through production OAuth;
2. inspect the demo project and Git status;
3. read a safe source file;
4. demonstrate `.env` credential-path refusal;
5. create a new file;
6. inspect the bounded Git diff for the known modified fixture file;
7. show a missing-write-scope refusal;
8. optionally demonstrate that file.replace correctly requests local approval rather than bypassing policy;
9. show that the result contains task-relevant data but not internal relay/provider telemetry.

Never expose OAuth tokens, recovery credentials, reviewer passwords, device private keys, absolute personal home paths, signing material or real user data in the recording. Host the final recording at a URL the OpenAI reviewer can access without private-network access or additional authentication.

## Claims that must NOT be made yet

Do not claim any of the following until the external gate is actually complete:

- OpenAI marketplace/plugin approval;
- successful production Scan Tools snapshot;
- production OAuth reviewer account is ready;
- reviewer-root/device startup and full device-backed E2E have passed. (`mecord-connect@1.0.0` publication and clean registry `doctor` are already complete.)
- the selected individual publisher identity has been verified by OpenAI and the exact verified spelling/order matches the deployed website/support/privacy/terms;
- all countries/regions are supported;
- zero risk, perfect security, or guaranteed execution.

## External submission gates

Before pressing Submit for Review, verify all of these against the real deployment:

- `https://operator.splcart.in/mcp` is the permanent production HTTPS MCP origin;
- if the OpenAI portal issues a challenge token, that exact token is served only at the required well-known path;
- OAuth metadata, authorization flow, PKCE/resource binding and reviewer credentials work from outside the publisher network;
- website, privacy, terms and support URLs return the deployed Mecord Connect production content over HTTPS and match the source-controlled notice set from deployed source `3b3b1bff35f8e78519f114b603f98e8acc56cd66`; hosting/region, actual retention, subprocessors and the private security-reporting path must remain real deployment values;
- hosted provider/region/subprocessor disclosures match the actual deployment;
- Scan Tools imports exactly the intended nine-tool public surface and current annotations;
- all nine annotation justifications match the scanned server values;
- the exact five positive and three negative cases are reproducible;
- the reviewer demo fixture is reset to baseline before the review run and the local runtime is installed from the public npm package, not a source checkout;
- country/region availability is limited to places where support/legal obligations are ready;
- release notes describe this as the initial public submission.

## Microsoft Store / MSIX

Microsoft Store/MSIX distribution is **outside Mecord Connect v1 scope**. Existing packaging tests may remain as engineering coverage, but Store identity reservation, Partner Center submission, Store signing and MSIX publication are not prerequisites for the npm runtime or OpenAI plugin submission and must not create extra v1 owner work.
