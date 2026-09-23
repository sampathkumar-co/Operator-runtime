# Mecord Connect Remaining Human / External Gates

Status date: 2026-09-18

This runbook contains only work that cannot be completed autonomously without the owner's account/credential entry, a platform-issued secret, or explicit irreversible authorization.

## Resolved external setup

The npm account setup gate is now independently verified from the owner machine:

- npm user: **mecrod**
- npm account/2FA setup was previously verified: **PASS**; a fresh publication CLI login is still required immediately before irreversible publish
- npm 2FA mode: **auth-and-writes**
- release package: **mecord-connect**
- npm organization/scope: **not required** for the unscoped package
- current registry state: **unpublished** before first release

Do not ask for an `@mecrod` organization again.

## Frozen production baseline

Production remains intentionally frozen on OCC-3M:

- main source: `405be7a03270c6c7ced78cd0d0d58314048a1af7`
- production edge image digest: `sha256:7f1114f7f78843db9bf1f8ea7d94baf1a9914bbe42f07d2fbea67db980aaec18`
- MCP: `https://operator.splcart.in/mcp`
- OAuth issuer: `https://auth.splcart.in`
- public MCP surface: exactly 10 tools

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

# The only five remaining owner/external gates

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

Scan Tools must show exactly the 10 public tools and no private terminal/browser/UIA/PostgreSQL surface.

Run the canonical five positive + three negative reviewer cases.

Capture the required reviewer-accessible production demo recording without exposing passwords, tokens, keys, private filesystem identity or real user data.

## 5. Explicit irreversible publication / deployment / submission authorization

This is the final owner-controlled release gate.

### npm first publication

The npm account prerequisite is already satisfied:
- user = `mecrod`
- 2FA = `auth-and-writes`

After the final exact source SHA is green:
1. build the immutable `mecord-connect@1.0.0` tarball;
2. verify its SHA-256;
3. publish **that exact tarball** interactively with owner 2FA;
4. verify public registry metadata;
5. from a clean Windows x64 environment run:
   - `npx mecord-connect@latest doctor`
   - `npx mecord-connect@latest remote --root C:\Users\Public\OperatorReviewerFixture\demo-project`

### final deployment

After publication/clean-machine verification and before real OpenAI review proof:
1. deploy the exact final Mecord Connect successor transactionally;
2. verify `/`, `/privacy`, `/terms`, `/support`;
3. verify OAuth discovery/protected-resource metadata;
4. verify MCP unauthenticated/authenticated behavior;
5. rerun hostile public-edge checks;
6. keep rollback to OCC-3M.

### OpenAI Submit for Review

Submit only after:
- exact publisher identity is verified and matches live legal pages;
- reviewer login/pairing passes;
- domain challenge is complete if issued;
- Scan Tools matches the 10-tool snapshot;
- real OAuth read/write/refusal/revoke/reconnect proof passes;
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
- final deployment scripting and rollback preparation;
- public-page/source branding consistency;
- security/red-team tests;
- production preflight/health checks;
- MSIX/Store work outside v1 scope.
