# Mecord Connect Remaining Human / External Gates

Status date: 2026-09-24

> **OpenAI submission-only checklist.** The npm/runtime/production release is already complete. These items do not block normal Mecord production use; they apply only if/when OpenAI developer verification permits directory submission.

This runbook contains only work that cannot be completed autonomously without the owner's account/credential entry, a platform-issued secret, or explicit irreversible authorization.

## Resolved external setup

The npm publication gate is resolved:

- npm user: **mecrod**
- npm 2FA mode: **auth-and-writes**
- release package: **mecord-connect@1.0.1**
- npm organization/scope: **not required** for the unscoped package
- registry state: **public under latest**
- clean registry install, installed doctor and remote --help: **PASS**
- reported vulnerabilities: **0**

Do not ask for an `@mecrod` organization again.

## Current production baseline

Production is live on Mecord Connect v1:

- source: `10914835e5ce4d8b1d2bf9952e8789efc8feb306`
- MCP: `https://operator.splcart.in/mcp`
- OAuth issuer: `https://auth.splcart.in`
- public MCP surface: exactly 9 tools
- legacy `device.claim`: absent
- fresh ChatGPT OAuth/tool refresh: **PASS**

OCC-3M remains the rollback baseline only.

## Owner decisions already resolved — do not ask again

- publisher type: Individual
- publisher source/legal name: **Kinthala Samuel Sampath Kumar**
- public locality: Akkayapalem, Visakhapatnam, Andhra Pradesh, India
- public support: support@splcart.in
- governing law: India
- dispute venue: competent courts at Visakhapatnam, Andhra Pradesh, subject to mandatory consumer/jurisdiction rules
- product: Mecord Connect
- software license: **PROPRIETARY**
- npm policy: **DUAL_USE**
- npm package: **mecord-connect**
- npm bin: **mecord-connect**
- v1 public domain: `operator.splcart.in`
- v1 auth issuer: `auth.splcart.in`
- availability intent: global wherever supported and legally/operationally supportable
- MSIX / Microsoft Store: **not a Mecord Connect v1 release requirement**

# Remaining owner/external gates

## 1. OpenAI publisher/developer login and individual identity verification

Use the real OpenAI publisher/developer account with Apps Management write permission.

Complete individual verification using the legal identity accepted by OpenAI.

Expected source identity:
- **Kinthala Samuel Sampath Kumar**

After verification, compare the exact verified spelling/order with:
- `.codex-plugin/plugin.json`;
- npm package author;
- proprietary LICENSE licensor;
- DISCLOSURE publisher;
- Privacy/Terms/Support source notices.

If verification accepts a materially different spelling/order, reconcile those source/public fields before final deployment/submission.

## 2. Reviewer credential entry and real reviewer pairing

A dedicated reviewer account and one-factor reviewer-only authorization policy are provisioned.

The certification agent must not retrieve, reveal, copy, log or bypass the password.

Owner action:
1. retrieve/enter the reviewer credential through the approved credential path;
2. verify it authenticates without MFA/SMS/email confirmation/private-network access;
3. pair only the canonical reviewer fixture.

Canonical reviewer fixture:
- root: `C:\Users\Public\OperatorReviewerFixture\demo-project`
- baseline commit: `ab658c353fc3e0ce79d71e2968f53eedbc247537`
- negative outside-root file: `C:\Users\Public\outside-project.txt`

## 3. OpenAI-issued domain challenge token, if the portal issues one

The runtime already supports:
- `OPENAI_APPS_CHALLENGE_TOKEN`
- `/.well-known/openai-apps-challenge`

Without a real portal token the challenge route must stay 404.

If OpenAI issues a token:
1. use that exact token only;
2. place it in the approved production secret/environment path;
3. verify the well-known challenge response;
4. complete portal verification;
5. remove/rotate it when no longer required.

Never commit or retain the raw challenge token in certification evidence.

## 4. Real OpenAI/ChatGPT OAuth, Scan Tools and end-to-end review proof

This gate requires the actual OpenAI-hosted flow.

OAuth proof must verify:
- S256 PKCE;
- exact portal callback;
- `resource=https://operator.splcart.in/mcp`;
- issuer `https://auth.splcart.in`;
- audience/resource `https://operator.splcart.in/mcp`;
- required read/write scopes;
- wrong/expired/wrong-scope tokens rejected;
- revoke/disconnect causes failure;
- reconnect succeeds.

Scan Tools must show exactly the canonical 9 public tools, must not show `device.claim`, and must expose no private terminal/browser/UIA/PostgreSQL surface.

Run the canonical five positive + three negative reviewer cases.

Capture the required reviewer-accessible production demo recording without exposing passwords, tokens, keys, private filesystem identity or real user data.

## 5. Final submission authorization

npm publication and final production deployment are complete. The remaining owner-controlled irreversible action is OpenAI submission.

### OpenAI Submit for Review

Submit only after:
- exact publisher identity is verified and matches live legal pages;
- reviewer login/pairing passes;
- domain challenge is complete if issued;
- Scan Tools matches the 9-tool snapshot;
- any reviewer-specific OAuth/refusal/revoke/reconnect evidence requested by OpenAI is captured after developer verification becomes available;
- five positive + three negative reviewer cases reproduce;
- reviewer-accessible demo recording exists;
- final region availability is set appropriately.

Do not click Submit for Review until the final certification verdict is green.

# Not an additional owner gate

These are engineering/release tasks and must not be presented as extra owner decisions:

- source fixes and regression testing;
- source/evidence synchronization;
- CI/platform/npm-runtime/signing certification;
- package/tarball inspection;
- release notes/reviewer packet preparation;
- rollback maintenance and production health verification;
- public-page/source branding consistency;
- security/red-team tests;
- production preflight/health checks;
- MSIX/Store work outside v1 scope.
