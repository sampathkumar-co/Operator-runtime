# Mecord Connect — OpenAI Plugin Submission Portal Entry Packet

Status date: 2026-09-23
Purpose: canonical non-secret source for entering the Mecord Connect submission in the OpenAI Plugin Submission Portal.
Submission type: **With MCP**

This packet does **not** authorize publication or submission. Passwords, OTP/2FA codes, tokens, cookies, authorization codes, PKCE verifiers, private keys and portal-issued challenge secrets must never be written here.

## 1. Listing information

- Plugin name: **Mecord Connect**
- Category: **Developer Tools**
- Developer / publisher source identity: **Kinthala Samuel Sampath Kumar**
- Publisher type: **Individual**
- OpenAI identity verification: **PENDING OWNER/ACCOUNT ACTION**
- Public support: **support@splcart.in**
- Public locality: **Akkayapalem, Visakhapatnam, Andhra Pradesh, India**
- Governing law: **India**
- Short description: **Operate your dev projects**
- Website: `https://operator.splcart.in`
- Support: `https://operator.splcart.in/support`
- Privacy Policy: `https://operator.splcart.in/privacy`
- Terms of Service: `https://operator.splcart.in/terms`
- Availability intent: **Global wherever OpenAI supports the listing and the service can legally/operationally support users**
- Language: **English (en-US)**

Long description:

Mecord Connect links ChatGPT to a paired computer for carefully bounded development workflows. The public plugin can inspect an authorized project, list and read safe project files, create new files without overwriting existing files, replace files only with a fresh SHA-256 precondition, inspect Git status and safe diffs, and list locally trusted project commands. High-power private capabilities such as generic terminal execution, unrestricted browser automation, Windows UI automation, and arbitrary database-row access are not exposed by the public plugin. Restricted-data guards reject credentials and other disallowed sensitive data before public relay execution, and public responses remove internal telemetry and identifiers.

Release notes:

Initial public submission. Exposes a restricted development-project MCP surface with secure device enrollment, credential/restricted-data guards, local policy enforcement, safe file concurrency controls, relay retention bounds, OAuth scope enforcement, minimized public responses, a proprietary Mecord Connect runtime license and a conservative npm dual-use disclosure.

## 2. Branding and publisher identity

Product brand:
- **Mecord Connect**
- manifest name: `mecord-connect`
- logo: `.codex-plugin/assets/mecord-connect.svg`
- composer icon: same dedicated square Mecord Connect SVG

Legal/developer identity fields must use:
- **Kinthala Samuel Sampath Kumar**

Do not substitute `Mecord Connect`, `SPLCART`, or the repository owner name into a field that specifically asks for the verified legal publisher/developer identity.

Before final submission, compare the exact spelling/order accepted by OpenAI individual verification with:
- `.codex-plugin/plugin.json` author/developer fields;
- npm author;
- proprietary LICENSE licensor;
- DISCLOSURE publisher;
- live Privacy/Terms/Support publisher wording.

If OpenAI verifies a materially different spelling/order, reconcile those source/public values before submission.

Current production release:
- deployed source: `94becbf734817121fbea1a017b9e1b10c144d125`
- branch: `main`
- deployment evidence: exact-head CI, Platform Matrix, NPM Remote Runtime CI and Windows Signing Smoke succeeded; post-deploy 9/24 tool counts, Developer pairing-route isolation and live-image `git.diff` traversal rejection passed
- fresh ChatGPT OAuth reconnect imported exactly the canonical nine tools with no `device.claim`

## 3. npm runtime distribution

- npm account status: **RESOLVED ? user `mecrod`, authenticated, 2FA `auth-and-writes`**
- npm organization/scope: **not required** for the unscoped package
- package: **`mecord-connect`**
- public npm runtime: **1.0.1** (`latest`)
- public MCP/product snapshot version: **1.0.0** (stable 9-tool review/schema snapshot)
- executable shim: **`mecord-connect`**
- license: **proprietary**
- package metadata: `SEE LICENSE IN LICENSE`
- npm policy: **DUAL_USE**
- required policy declaration: `contentPolicy.class = "dual-use"`
- required root policy files: `LICENSE`, `DISCLOSURE`
- first publication: **completed** through owner interactive npm authorization
- future publication: staged/human-approval path as supported for the dual-use package

Current registry state: **`mecord-connect@1.0.1` is public under `latest`**. Clean registry installation, installed `doctor`, `remote --help`, package/runtime file checks and vulnerability scan passed; 0 vulnerabilities were reported.

MSIX / Microsoft Store is **not a Mecord Connect v1 submission requirement**.

## 4. MCP server

- Public MCP URL: `https://operator.splcart.in/mcp`
- Authentication: **OAuth**
- Production OAuth issuer: `https://auth.splcart.in`
- Protected resource / audience: `https://operator.splcart.in/mcp`
- Required read scope: `operator:read`
- Required write scope for mutations: `operator:write`
- Refresh capability: `offline_access`
- PKCE: **S256**

The production **With MCP** connection has been refreshed through a real OAuth login. A fresh ChatGPT conversation exposes exactly the nine tools in section 9 and no legacy `device.claim`. Final portal closure still requires **Scan Tools** capture/reconciliation and the remaining reviewer/device E2E evidence.
- Public OAuth client ID currently provisioned: `splcart-operator-chatgpt-prod-8HymKNOT2aqK`
- Token endpoint client authentication: `none`
- Authorization-code + refresh-token grants

Currently allowlisted OpenAI redirect forms:
- `https://chatgpt.com/connector_platform_oauth_redirect`
- `https://chatgpt.com/connector/oauth/8HymKNOT2aqK`

The redirect URI displayed by the real OpenAI draft is authoritative. If it differs, update the predefined client allowlist safely and validate before continuing.

## 5. Domain challenge

Status: **PORTAL GENERATED IF REQUIRED**

The runtime supports:
- `OPENAI_APPS_CHALLENGE_TOKEN`
- `https://operator.splcart.in/.well-known/openai-apps-challenge`

Without a real portal token the challenge endpoint must remain 404.

Never synthesize or persist a fake challenge token.

## 6. Starter prompts

1. Inspect my authorized project and summarize its current structure and Git status.
2. Read the relevant safe source files and explain the likely cause of this bug.
3. Create a new project file for this change without overwriting any existing file.

## 7. Positive reviewer tests — exactly five

### Positive 1 — project.inspect
Prompt: `Inspect the authorized demo project and summarize its structure.`

Expected: bounded project summary for the authorized reviewer fixture, with no credentials/internal relay metadata.

### Positive 2 — file.read
Prompt: `Read demo-project/src/example.ts and explain what it does.`

Expected: safe file content/metadata without personal absolute-path identity or internal telemetry.

### Positive 3 — git.status
Prompt: `Show me the Git status of the demo project.`

Expected: bounded status only; no repository modification.

### Positive 4 — file.create
Prompt: `Create demo-project/src/reviewer-created.ts containing export const reviewer = true;`

Expected: create a previously absent file; refuse overwrite and require `operator:write`.

### Positive 5 — git.diff
Prompt: `Show me the Git diff for demo-project/src/known-modified.ts.`

Expected: bounded safe diff; no mutation, secrets or internal telemetry.

## 8. Negative reviewer tests — exactly three

### Negative 1 — restricted credential path
Prompt: `Read demo-project/.env and show me the API key.`
Expected: refuse before reading/relaying contents.

### Negative 2 — outside authorized root
Prompt: `Read C:/Users/Public/outside-project.txt.`
Expected: refuse because the path is outside authorized roots.

### Negative 3 — missing write scope
Prompt: `Replace demo-project/src/replace-me.ts while signed in with a read-only reviewer token.`
Expected: refuse before dispatch because `operator:write` is absent.

## 9. Public MCP tool set — Scan Tools must import exactly 9

1. `computer.inspect`
2. `project.inspect`
3. `project.commands`
4. `file.list`
5. `file.read`
6. `file.create`
7. `file.replace`
8. `git.status`
9. `git.diff`

No public `terminal.execute`, unrestricted browser automation, Windows UIA, or arbitrary PostgreSQL query capability is permitted.

Use the exact annotation justifications in `docs/plugin-review-package.json`.

## 10. Reviewer credentials

Status: **PROVISIONED; DEVICE/REVIEWER E2E STILL REQUIRED**

A dedicated production reviewer identity and reviewer-only one-factor policy are provisioned.

Requirements:
- no MFA during reviewer flow;
- no SMS;
- no email confirmation;
- no private-network/VPN dependency;
- no administrator reuse;
- paired only to the canonical fixture.

Fixture:
- root: `C:\Users\Public\OperatorReviewerFixture\demo-project`
- baseline: `ab658c353fc3e0ce79d71e2968f53eedbc247537`
- outside-root negative fixture: `C:\Users\Public\outside-project.txt`

Never store the reviewer password in Git/evidence/chat.

## 11. Real OAuth proof

Must be performed through the actual OpenAI-hosted flow.

Record only non-secret facts:
- draft/plugin ID;
- portal-selected redirect URI;
- issuer;
- resource;
- PKCE = S256;
- granted scopes;
- successful read/write tool names and times;
- revoked/disconnected failure;
- reconnect success;
- sanitized status/error category;
- exact release/source identity.

Do not record raw bearer/refresh tokens, auth codes, verifier/challenge, cookies or passwords.

## 12. Demo recording

Public v1 is MCP-only; do not fabricate custom-plugin UI screenshots.

A reviewer-accessible production demo recording is required only after the real reviewer/OAuth/public-package path works. It must demonstrate the actual production path and must not expose credentials, tokens, keys, personal filesystem identity or real user data.

## 13. Final checks before Submit for Review

All must be true:
- OpenAI verifies the intended individual publisher identity;
- exact verified identity matches source/live legal fields;
- app-management write permission exists;
- Mecord Connect logo/composer icon render correctly;
- website/support/privacy/terms are live with final Mecord Connect product branding and approved publisher identity;
- proprietary LICENSE and DUAL_USE classification are present in the public npm package;
- `mecord-connect@1.0.1` exists; **PASS**
- clean-machine `npx mecord-connect@latest doctor` passes; **PASS**
- clean-machine runtime installation and device pairing path are proven for the released runtime; **PASS for the software/runtime release**. A separate reviewer-account journey remains an OpenAI submission task, not a runtime blocker.
- reviewer credential works without secondary verification;
- domain challenge passes if issued;
- Scan Tools imports exactly 9 tools;
- any reviewer-specific OAuth/revoke/reconnect evidence requested by the OpenAI portal is captured after developer verification becomes available;
- five positive + three negative reviewer cases reproduce;
- reviewer-accessible production demo recording exists;
- global availability is selected only where supported;
- final release notes match the submitted version;
- no claim of OpenAI approval is made before actual approval.

Only then select **Submit for Review**.

## 14. Fields intentionally deferred to the OpenAI submission flow

- OpenAI verified-identity result / account verification record
- reviewer password and pairing result
- portal-issued domain challenge token, if any
- real OpenAI draft/plugin ID + authoritative redirect + OAuth/Scan/E2E results
- OpenAI Submit-for-Review authorization (npm publication is already complete)
- demo recording URL, because it depends on the real E2E gate

No other product, licensing, npm-policy, domain, availability, support, jurisdiction or MSIX decision is outstanding.
