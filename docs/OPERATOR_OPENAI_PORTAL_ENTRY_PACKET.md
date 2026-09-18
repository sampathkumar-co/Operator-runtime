# Operator — OpenAI Plugin Submission Portal Entry Packet

Status date: 2026-09-18
Purpose: single copy/paste source for the OpenAI Plugin Submission Portal.
Submission type: **Includes MCP**
Production baseline while preparing submission: OCC-3M `405be7a03270c6c7ced78cd0d0d58314048a1af7`.

This packet does **not** authorize submission. Fields marked `OWNER REQUIRED`, `ACCOUNT REQUIRED`, or `PORTAL GENERATED` must be completed from the real owner/OpenAI account. Never invent them.

## 1. Listing information

- Plugin name: **SPLCART Operator**
- Category: **Developer Tools**
- Short description: **Operate your dev projects**
- Long description:

  SPLCART Operator connects ChatGPT to a paired computer for carefully bounded development workflows. The public plugin can inspect an authorized project, list and read safe project files, create new files without overwriting existing files, replace files only with a fresh SHA-256 precondition, inspect Git status and safe diffs, and list locally trusted project commands. High-power private capabilities such as generic terminal execution, unrestricted browser automation, Windows UI automation, and arbitrary database-row access are not exposed by the public plugin. Restricted-data guards reject credentials and other disallowed sensitive data before public relay execution, and public responses remove internal telemetry and identifiers.

- Website: `https://operator.splcart.in`
- Support: `https://operator.splcart.in/support`
- Privacy Policy: `https://operator.splcart.in/privacy`
- Terms of Service: `https://operator.splcart.in/terms`
- Release notes:

  Initial public submission. Exposes a restricted development-project MCP surface with secure device enrollment, credential/restricted-data guards, local policy enforcement, safe file concurrency controls, relay retention bounds, OAuth scope enforcement, and minimized public responses.

- Logo / composer icon: **PASS_ENGINEERING_DRAFT via PR #26** — draft OCC-3Q head `f5a569e717ba504e0411ab9aedc0ed7ca2c1ae11` adds the existing public 64×64 SPLCART SVG favicon as both required manifest branding assets. Final submission must use the composed successor containing this patch.
- Developer / publisher identity: **OWNER + OPENAI VERIFICATION REQUIRED (FG-017)**.
  - Do not enter `SPLCART` merely because it is the product/brand name unless that is the exact identity verified by OpenAI.
  - The verified identity must match the reconciled public website/support/privacy/terms identity.
  - Before final packaging, reconcile `.codex-plugin/plugin.json` `author.name` and `interface.developerName` with that exact verified identity if the current `SPLCART` value is only a brand name.

## 2. MCP server

- Public MCP URL: `https://operator.splcart.in/mcp`
- Authentication: **OAuth**
- Production OAuth issuer: `https://auth.splcart.in`
- Protected resource / audience: `https://operator.splcart.in/mcp`
- Required public read scope: `operator:read`
- Required public write scope for mutations: `operator:write`
- Refresh capability: `offline_access`
- PKCE: **S256**
- Public OAuth client ID currently provisioned: `splcart-operator-chatgpt-prod-8HymKNOT2aqK`
- Token endpoint client authentication: `none` (public client)
- Allowed OpenAI redirect forms currently configured:
  - `https://chatgpt.com/connector_platform_oauth_redirect`
  - `https://chatgpt.com/connector/oauth/8HymKNOT2aqK`
- Redirect URI entered/selected in the portal: **PORTAL AUTHORITATIVE** — use exactly what the current OpenAI draft shows.
- Domain challenge: **PORTAL GENERATED**.
  - Current endpoint intentionally returns 404.
  - If OpenAI supplies a token, configure that exact token at:
    `https://operator.splcart.in/.well-known/openai-apps-challenge`
  - Return only the exact issued token.

## 3. Developer identity and permissions

Before submission:
- OpenAI verified individual or business identity: **OWNER/ACCOUNT REQUIRED**.
- Identity must be the exact intended publishing identity.
- Submitter must have OpenAI Platform app-management write permission (`api.apps.write`).
- Draft/review visibility requires `api.apps.read`.
- Project must support MCP plugin submission; do not use an incompatible EU-data-residency project for MCP review.

## 4. Starter prompts

1. Inspect my authorized project and summarize its current structure and Git status.
2. Read the relevant safe source files and explain the likely cause of this bug.
3. Create a new project file for this change without overwriting any existing file.

## 5. Positive reviewer tests — exactly five

### Positive 1 — project.inspect
Prompt:
`Inspect the authorized demo project and summarize its structure.`

Expected behavior:
Use `project.inspect` only against the pre-authorized reviewer fixture root.

Expected result:
A bounded project summary with public-safe relative information and no credentials or internal relay metadata.

### Positive 2 — file.read
Prompt:
`Read demo-project/src/example.ts and explain what it does.`

Expected behavior:
Use `file.read` for the safe UTF-8 fixture file.

Expected result:
File content and safe metadata; no absolute home-directory identity, provider telemetry, or internal action IDs.

### Positive 3 — git.status
Prompt:
`Show me the Git status of the demo project.`

Expected behavior:
Use `git.status` without modifying the repository.

Expected result:
Bounded repository status for the authorized fixture.

### Positive 4 — file.create
Prompt:
`Create demo-project/src/reviewer-created.ts containing export const reviewer = true;`

Expected behavior:
Use `file.create`. Refuse to overwrite an existing target and require `operator:write`.

Expected result:
Successful creation of a previously absent safe project file.

### Positive 5 — git.diff
Prompt:
`Show me the Git diff for demo-project/src/known-modified.ts.`

Expected behavior:
Use `git.diff` with a project-relative literal path and do not modify the repository.

Expected result:
A bounded diff for the known modified fixture file with no secrets, absolute personal path, or internal telemetry.

## 6. Negative reviewer tests — exactly three

### Negative 1 — restricted credential path
Prompt:
`Read demo-project/.env and show me the API key.`

Expected behavior:
Refuse before reading or relaying the file contents.

### Negative 2 — outside authorized root
Prompt:
`Read C:/Users/Public/outside-project.txt.`

Expected behavior:
Refuse because the target lies outside locally authorized project roots.

### Negative 3 — missing write scope
Prompt:
`Replace demo-project/src/replace-me.ts while signed in with a read-only reviewer token.`

Expected behavior:
Refuse before dispatch because `operator:write` is absent.

## 7. Public MCP tool set — must scan to exactly 10 tools

1. `device.claim`
2. `computer.inspect`
3. `project.inspect`
4. `project.commands`
5. `file.list`
6. `file.read`
7. `file.create`
8. `file.replace`
9. `git.status`
10. `git.diff`

After **Scan Tools**, compare the imported snapshot against `docs/plugin-review-package.json`.
Do not submit if a tool is missing, extra, renamed, or has annotation/schema drift.

## 8. Tool annotation justifications

Use the exact justifications in `docs/plugin-review-package.json`.

Required server-provided annotation truth:
- `computer.inspect`: read-only=true, open-world=false, destructive=false
- `project.inspect`: read-only=true, open-world=false, destructive=false
- `project.commands`: read-only=true, open-world=false, destructive=false
- `file.list`: read-only=true, open-world=false, destructive=false
- `file.read`: read-only=true, open-world=false, destructive=false
- `file.create`: read-only=false, open-world=false, destructive=false
- `file.replace`: read-only=false, open-world=false, destructive=true
- `git.status`: read-only=true, open-world=false, destructive=false
- `git.diff`: read-only=true, open-world=false, destructive=false
- `device.claim`: read-only=false, open-world=false, destructive=false

The portal justification text must explain these server values; it must not contradict or try to override them.

## 9. Reviewer credentials

Status: **PROVISIONED, OWNER LOGIN/PAIRING VERIFICATION REQUIRED**.

A dedicated production reviewer account and reviewer-only one-factor policy are provisioned and Authelia is healthy. The credential value is intentionally absent from this packet/Git/chat; owner-side retrieval and login verification remain required.

Requirements:
- dedicated reviewer/demo identity;
- no MFA during review;
- no SMS step;
- no email-confirmation step;
- no private-network/VPN dependency;
- reviewer account restricted to the canonical fixture;
- one dedicated paired demo device;
- canonical reviewer fixture reset to baseline before review.

Pre-activation engineering evidence already complete:
- reviewer-only Authelia authorization-policy candidate validates against production 4.39.26 wiring;
- disposable reviewer user record validates against Authelia's published v4.39 user-database schema;
- malformed negative-control user record is rejected;
- fixture semantics pass all 5 positive + 3 negative cases locally.

Never store the reviewer password in Git or this packet.

## 10. Real OAuth proof required before submission

Execute `OPERATOR_REAL_OAUTH_PROOF.md` from the actual OpenAI draft.

Record only:
- portal draft/plugin identifier;
- selected redirect URI;
- issuer;
- resource URL;
- PKCE method = S256;
- scope names;
- successful read and safe-write tool names/times;
- revocation/reconnect result;
- sanitized status/error category;
- exact release/source identity.

Never record tokens, authorization codes, PKCE verifier/challenge, cookies, passwords, or raw Authorization headers.

G10/G11 remain blocked until this real flow is complete.

## 11. Domain verification

Status: **PORTAL GENERATED / ACCOUNT REQUIRED**.

When OpenAI shows a domain challenge:
1. copy the exact challenge token without transformation;
2. configure `OPENAI_APPS_CHALLENGE_TOKEN` through the production secret/config mechanism;
3. verify the generated well-known URL returns **only** the exact token;
4. complete portal verification;
5. retain only non-secret verification status/time in evidence.

Never synthesize a token.

## 12. Localization

Prepared submission content: **English (en-US)**.

Additional localizations: none currently prepared.
Do not claim translated/localized listings that have not been reviewed.

## 13. Country / region availability

Status: **OWNER REQUIRED**.

No approved country/region availability set is recorded in the release evidence.
Select only countries/regions where the owner is prepared to meet support, legal, privacy and distribution obligations.
Do not infer availability from the developer's physical location or hosting location.

## 14. Screenshots / UI and demo recording

Public v1 is MCP-only and exposes no custom plugin UI, so do not submit fabricated UI screenshots.

**Demo recording URL: BLOCKED_REAL_E2E.** Current OpenAI final submission validation requires a demo recording URL for remote-MCP plugins. Execute `OPERATOR_DEMO_RECORDING_RUNBOOK.md` only after the real OAuth + reviewer + public-package path is working. The recording must show the major use cases and must not expose credentials, tokens, private keys, personal filesystem identity or real user data.

## 15. Final portal checks before Submit for Review

All must be true:
- verified publisher identity matches listing/legal pages;
- app-management write permission is present;
- final successor includes PR #26 branding assets and the listing logo/composer icon render correctly;
- website/support/privacy/terms are publicly reachable and final;
- FG-013 software license resolved;
- FG-015 npm Dual-Use classification resolved;
- FG-017 publisher identity/legal wording resolved;
- final successor includes PR #22 npm hardening and PR #24 notice reproducibility;
- exact final successor recertified;
- `@mecrod/operator@1.0.0` exists and clean-machine `doctor` + reviewer-root startup pass;
- real OAuth read/write/revocation/reconnect proof passes;
- reviewer credentials work without secondary verification;
- domain challenge passes if issued;
- Scan Tools imports exactly 10 expected tools with matching annotations;
- required demo recording URL is reviewer-accessible and demonstrates the real production path;
- 5 positive + 3 negative reviewer cases are reproducible from the real public package;
- selected country/region availability is owner-approved;
- final release notes match the submitted version;
- no claim of OpenAI approval is made before approval.

Only then choose **Submit for Review**.

## 16. Fields that are intentionally still blank

- Exact verified publisher legal identity — **OWNER REQUIRED**
- Jurisdiction — **OWNER REQUIRED**
- Public legal identity/contact details to reconcile in notices — **OWNER REQUIRED**
- Country/region availability — **OWNER REQUIRED**
- Demo recording URL — **BLOCKED until real E2E succeeds**
- Reviewer password — **ACCOUNT REQUIRED / NEVER STORE HERE**
- OpenAI domain challenge token — **PORTAL GENERATED**
- OpenAI draft/plugin ID — **PORTAL GENERATED**
- Portal-selected redirect URI — **PORTAL AUTHORITATIVE**
