# Mecord Connect OpenAI Release Certification — September 2026

## Certification status

**NOT YET CONFIRMED FOR RELEASE.**

Engineering work is substantially complete, but five external/account actions remain and are intentionally excluded from autonomous execution.

This document is an engineering certification record, not a claim of OpenAI approval.

## Frozen production baseline

Production remains intentionally frozen on OCC-3M:

- source: `405be7a03270c6c7ced78cd0d0d58314048a1af7`
- edge image digest: `sha256:7f1114f7f78843db9bf1f8ea7d94baf1a9914bbe42f07d2fbea67db980aaec18`
- MCP: `https://operator.splcart.in/mcp`
- OAuth issuer: `https://auth.splcart.in`
- public surface: exactly 10 MCP tools, including the legacy public `device.claim` enrollment tool

OCC-3M production is healthy and remains the rollback/safety baseline until the final successor is allowed to deploy.

## Current Mecord Connect successor

Certified hardening baseline: `71b7c122a04b97637d17e4ae296437d64ad20620`, the merge of exact-head green PR #28.

Current source baseline: `main` merge `d51a3b2ee4746e1a29f9cf2ec87cef603ac76edf`, which adds only the independently green PR #29 production-notice branding cleanup.

There is no active engineering successor at this checkpoint. Any future release-candidate branch must establish fresh exact-head evidence before deployment/submission.

This candidate includes:

- product rebrand to **Mecord Connect** across the actual public plugin/MCP surface;
- dedicated square Mecord Connect SVG for logo and composer icon;
- plugin manifest `mecord-connect` / **Mecord Connect**;
- OAuth protected-resource `resource_name: Mecord Connect`;
- public MCP initialize `name: mecord-connect` / `title: Mecord Connect`;
- exactly 9 public MCP tools;
- source-controlled Privacy/Terms/Support notices;
- individual publisher identity **Kinthala Samuel Sampath Kumar**;
- public locality **Akkayapalem, Visakhapatnam, Andhra Pradesh, India**;
- support **support@splcart.in**;
- India governing law / Visakhapatnam venue wording subject to mandatory protections;
- npm package renamed to **`mecord-connect`**;
- npm executable shim **`mecord-connect`**;
- proprietary package license;
- mandatory npm dual-use classification/disclosure;
- immutable first-release artifact handling and staged future-release controls;
- source/tarball/runtime integrity checks;
- Windows-native DPAPI/UIA/path-authority boundary;
- Git fixture cleanup retry hardening for transient recursive-removal races.

PR #28 exact-head hardening result before merge:
- CI #911: **PASS**
- Platform Matrix #681: **PASS**
- NPM Remote Runtime #311: **PASS**
- Windows Signing Smoke #682: **PASS**

PR #29 notice-only cleanup then passed CI #914, Platform Matrix #684 and Windows Signing Smoke #685 before merge. The npm runtime payload was unchanged by PR #29. Current `main` is `d51a3b2ee4746e1a29f9cf2ec87cef603ac76edf`.

## Owner decisions already resolved in source

The following are **not** open decisions anymore:

- publisher type: **Individual**
- publisher source/legal name: **Kinthala Samuel Sampath Kumar**
- product: **Mecord Connect**
- support: **support@splcart.in**
- locality: **Akkayapalem, Visakhapatnam, Andhra Pradesh, India**
- software license: **PROPRIETARY**
- npm classification: **DUAL_USE**
- npm package: **`mecord-connect`**
- v1 domain: **operator.splcart.in**
- auth issuer: **auth.splcart.in**
- availability intent: **global wherever supported and legally/operationally supportable**
- MSIX/Microsoft Store: **not a Mecord Connect v1 release requirement**

If OpenAI identity verification accepts a materially different legal-name spelling/order, reconcile the source/public publisher fields before submission.

## npm package truth

The publishable runtime source is `packages/mecord-connect`.

Required metadata and files:

- `name = mecord-connect`
- `license = SEE LICENSE IN LICENSE`
- `contentPolicy.class = dual-use`
- author = **Kinthala Samuel Sampath Kumar**
- contact = **support@splcart.in**
- bin = **mecord-connect**
- root `LICENSE`
- root `DISCLOSURE`

Release guards fail closed if the package name, proprietary license, dual-use declaration, disclosure or approved publisher identity is removed/changed.

GitHub NPM Runtime certification builds the native helpers, builds the exact-source runtime payload, packs the tarball, verifies required policy/runtime files, installs the tarball, runs the direct runtime doctor, and runs the installed `mecord-connect.cmd` doctor.

The package is not yet public. npm account setup is resolved: `npm whoami` = **mecrod** and 2FA mode = **auth-and-writes**; because the package is unscoped, no npm organization/scope is required. Publication now waits only for explicit irreversible authorization plus post-publish verification.

## Public MCP surface

Exactly 9 tools:

1. `computer.inspect`
2. `project.inspect`
3. `project.commands`
4. `file.list`
5. `file.read`
6. `file.create`
7. `file.replace`
8. `git.status`
9. `git.diff`

Generic terminal, unrestricted browser automation, raw Windows UI Automation and arbitrary PostgreSQL access are deliberately not exposed by the public plugin.

`docs/plugin-review-package.json` contains matching annotation justifications plus exactly five positive and three negative reviewer cases.

## Reviewer fixture

Canonical fixture:

- root: `C:\Users\Public\OperatorReviewerFixture\demo-project`
- baseline: `ab658c353fc3e0ce79d71e2968f53eedbc247537`
- outside-root negative fixture: `C:\Users\Public\outside-project.txt`

Local public-boundary semantics pass the submitted five positive and three negative cases. Additional checks demonstrate:
- `file.replace` without one-time local approval -> `APPROVAL_REQUIRED`
- duplicate `file.create` -> `TARGET_EXISTS`

A dedicated production reviewer identity and reviewer-only one-factor policy are provisioned. Password login/pairing verification remains owner-controlled.

## OAuth engineering state

Production OAuth uses a predefined public client with:

- issuer: `https://auth.splcart.in`
- protected resource/audience: `https://operator.splcart.in/mcp`
- PKCE: S256
- public client / token endpoint method `none`
- read/write scopes plus OIDC/offline scopes
- authorization-code + refresh-token grants
- JWKS/discovery
- stable OpenAI redirect allowlist:
  - `https://chatgpt.com/connector_platform_oauth_redirect`
  - existing callback-ID redirect

Provider preflight and redirect acceptance are proven.

Real OpenAI-hosted authorization/code-exchange, issued-token audience/scope proof, revocation/reconnect and ChatGPT E2E remain external.

## Production isolation/security baseline

Production OCC-3M previously passed:

- TLS 1.3 / valid certificate;
- HSTS/CSP/nosniff/frame denial/no-referrer;
- forged Host -> 421;
- malicious Origin -> 403;
- missing/invalid bearer -> 401;
- oversized header -> 431;
- body >1 MiB -> 413;
- public direct backend/control ports blocked;
- no fatal crash signatures from hostile probes.

Shared ingress uses strict SNI host enforcement. The internal public-edge/gateway containers retain hardened filesystem/capability boundaries.

The final successor must receive a fresh hostile/public-page check after deployment; historical OCC-3M evidence does not substitute for final deployment proof.

## Historical engineering provenance

Earlier PRs remain useful provenance but are no longer the current candidate:

- PR #22 introduced npm/publication hardening;
- PR #24 made public legal notices reproducible from source;
- earlier PR #27 heads introduced the Mecord Connect rebrand and exact public MCP identity.

Their decisions and functionality are integrated into current `main` through the merged PR #28 hardening baseline. They must not be treated as alternate release candidates.

## MSIX / Microsoft Store

Existing MSIX/Store engineering may remain tested as an optional/future lane.

It is **not** a Mecord Connect v1 release, npm publication, OpenAI submission or public-plugin gate.

Do not create extra owner work for Store naming/reservation/publication during v1.

## Remaining five external/account gates

### 1. OpenAI publisher/developer login + individual identity verification
Complete/verify the exact individual identity and reconcile the accepted spelling/order if needed.

### 2. Reviewer credential entry + real pairing
Owner enters the provisioned reviewer credential, proves no secondary verification and pairs only the canonical fixture.

### 3. Portal-issued domain challenge, if issued
Use only the exact OpenAI-issued challenge token.

### 4. Real OpenAI/ChatGPT OAuth + Scan Tools + E2E + demo
Prove issued-token resource/scopes, exact 9-tool scan, reviewer cases, revoke/reconnect and the reviewer-accessible production demo.

### 5. Explicit irreversible publication / deployment / submission authorization
Authorize publication of the exact certified `mecord-connect` tarball with 2FA, final transactional deployment, then OpenAI Submit for Review only after the real review proof is green.

## Final deployment sequencing

Final Mecord Connect production deployment is an engineering release step, not a new product decision, but it must wait until the external gates make the deployment meaningful and safe.

When permitted:
1. deploy the exact final certified successor transactionally;
2. verify `/`, `/privacy`, `/terms`, `/support`;
3. verify OAuth discovery/protected-resource metadata;
4. verify MCP unauthenticated/authenticated behavior;
5. rerun hostile public-edge checks;
6. verify the approved publisher identity on live legal pages;
7. run Scan Tools / real ChatGPT proof on that deployed final SHA;
8. retain rollback capability to OCC-3M.

## Release verdict

Until the five external gates and final deployment verification close, the verdict remains:

**NOT CONFIRMED FOR RELEASE**

See:
- `OPERATOR_MASTER_GATE_STATUS.md` — canonical G0–G36 verdict
- `OPERATOR_RELEASE_GATE.md` — compact binary release sheet
- `OPERATOR_FEATURE_GAPS.md` — discovered/resolved/open gaps
- `OPERATOR_REMAINING_HUMAN_GATES.md` — exact five human/external gates
- `OPERATOR_OPENAI_PORTAL_ENTRY_PACKET.md` — portal-entry source
- `docs/plugin-review-package.json` — reviewer/tool package
