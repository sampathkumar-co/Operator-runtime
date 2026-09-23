# Mecord Connect OpenAI Release Certification — September 2026

## Certification status

**MECORD CONNECT v1 IS LIVE; OPENAI SUBMISSION/APPROVAL IS NOT YET COMPLETE.**

The production edge and npm runtime are released. Remaining work is limited to OpenAI/reviewer/device evidence and final submission actions that are intentionally not inferred from source-only tests.

This document is an engineering certification record, not a claim of OpenAI approval.

## Current production baseline

Production is live on Mecord Connect v1:

- source: `3b3b1bff35f8e78519f114b603f98e8acc56cd66`
- MCP: `https://operator.splcart.in/mcp`
- OAuth issuer: `https://auth.splcart.in`
- public surface: exactly 9 MCP tools
- legacy public `device.claim`: absent
- fresh ChatGPT OAuth connection: completed and tool definitions refreshed

OCC-3M `405be7a03270c6c7ced78cd0d0d58314048a1af7` / image `sha256:7f1114f7f78843db9bf1f8ea7d94baf1a9914bbe42f07d2fbea67db980aaec18` is retained only as the rollback baseline.

## Current Mecord Connect release

Certified hardening baseline: `71b7c122a04b97637d17e4ae296437d64ad20620`, the merge of exact-head green PR #28.

Release-alignment baseline: PR #30 merge `7e43c14bafcd207d208a0744bd6d8910fafedd6e`, following the PR #29 production-notice branding cleanup.

The deployed v1 source is exact commit `3b3b1bff35f8e78519f114b603f98e8acc56cd66`. The release run reported 19/19 CI checks green and 437 passed / 17 expected skips / 0 failures before/through deployment verification.

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

PR #29 notice-only cleanup then passed CI #914, Platform Matrix #684 and Windows Signing Smoke #685 before merge. PR #30 exact head `c6589dd6437c4efcacf88059a219b82ae8585a73` subsequently passed the full required check set before the release-alignment merge `7e43c14bafcd207d208a0744bd6d8910fafedd6e`. The exact current `main` head remains dynamic release evidence.

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

The package is public as **`mecord-connect@1.0.0`** under the **`latest`** tag, published by npm user **mecrod** from source `3b3b1bff35f8e78519f114b603f98e8acc56cd66`. Post-publish verification passed: clean registry installation, installed `doctor`, `remote --help`, package/runtime file checks and vulnerability scan; 0 vulnerabilities were reported.

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

Provider preflight and redirect acceptance are proven. A real ChatGPT-hosted OAuth sign-in/reconnect also completed and refreshed the live nine-tool definition.

Issued-token audience/scope capture, explicit revoke/disconnect failure + reconnect recovery, and device-backed read/write E2E remain external. The first live `computer.inspect` reached Mecord but returned `ROUTE_NO_DEVICE` because the paired local runtime was offline.

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
