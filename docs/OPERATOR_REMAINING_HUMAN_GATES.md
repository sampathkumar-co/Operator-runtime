# Mecord Connect Remaining Human / External Gates

Status date: 2026-09-18

This runbook intentionally contains only work that cannot be completed autonomously without the owner's account access, credential entry, platform-issued secret, or explicit release/submission authorization.

Everything else belongs in the engineering/certification evidence and should be completed before this runbook is considered the only remaining blocker set.

## Frozen production baseline

Production remains intentionally frozen on OCC-3M until these external gates close:

- main source: `405be7a03270c6c7ced78cd0d0d58314048a1af7`
- production edge image digest: `sha256:7f1114f7f78843db9bf1f8ea7d94baf1a9914bbe42f07d2fbea67db980aaec18`
- MCP: `https://operator.splcart.in/mcp`
- OAuth issuer: `https://auth.splcart.in`
- public MCP surface: exactly 10 tools

The current release successor is **Mecord Connect**. The source candidate, evidence SHA and exact workflow numbers must be taken from the final certification ledger after the last engineering fix is green.

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
- npm package: **@mecrod/connect**
- npm bin: **mecord-connect**
- v1 public domain: `operator.splcart.in`
- v1 auth issuer: `auth.splcart.in`
- availability intent: global wherever supported and legally/operationally supportable
- MSIX / Microsoft Store: **not a Mecord Connect v1 release requirement**

If OpenAI identity verification accepts a different legal-name spelling/order than the source value above, reconcile source/public metadata before submission. That is identity reconciliation, not a new product/branding decision.

# The only six remaining owner/external gates

## 1. npm account, @mecrod scope and 2FA

The owner currently has no npm publisher account configured for this release.

Required owner actions:

1. create or sign into the intended npm account;
2. enable npm 2FA;
3. obtain/control the `@mecrod` scope, if available and required by npm;
4. verify that account may publish `@mecrod/connect`.

Do not paste passwords, OTP/2FA codes, auth tokens, session cookies or recovery codes into Git or ChatGPT.

Engineering state already prepared:
- package = `@mecrod/connect@1.0.0`;
- proprietary LICENSE is included;
- dual-use DISCLOSURE is included;
- `contentPolicy.class = "dual-use"` is mandatory;
- first release is an immutable artifact handoff;
- future releases retain staged/human-approval controls;
- package doctor and installed `mecord-connect.cmd` are CI-tested.

## 2. OpenAI publisher/developer login and individual identity verification

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

## 3. Reviewer credential entry and real reviewer pairing

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

Do not reuse an administrator identity for reviewer access.

## 4. OpenAI-issued domain challenge token, if the portal issues one

The runtime already supports:
- `OPENAI_APPS_CHALLENGE_TOKEN`
- `/.well-known/openai-apps-challenge`

Without a real portal token the challenge route must stay 404.

If OpenAI issues a token:
1. enter that exact token into the approved production secret/environment field;
2. recreate only the components required to reload it;
3. verify the challenge URL returns exactly the issued value with no-store semantics;
4. complete portal verification;
5. remove or rotate the temporary value when no longer required.

Never commit or retain the raw challenge token in certification evidence.

## 5. Real OpenAI/ChatGPT OAuth, Scan Tools and end-to-end review proof

This gate requires the actual OpenAI-hosted flow and therefore cannot be replaced by locally minted tokens or simulated portal state.

OAuth proof must verify:
- S256 PKCE;
- exact portal callback;
- `resource=https://operator.splcart.in/mcp` in authorization and token flow;
- issuer `https://auth.splcart.in`;
- audience/resource `https://operator.splcart.in/mcp`;
- required read/write scopes;
- wrong/expired/wrong-scope tokens rejected;
- revocation/disconnect causes failure;
- reconnect succeeds.

Scan Tools must show exactly the 10 public tools and no private terminal/browser/UIA/PostgreSQL surface.

Real ChatGPT reviewer cases:
1. project.inspect;
2. file.read;
3. git.status;
4. file.create on an absent fixture file;
5. git.diff;
6. credential/.env refusal;
7. outside-root refusal;
8. read-only-token mutation refusal.

The required reviewer-accessible production demo recording must be captured from this real flow without exposing passwords, tokens, private keys, private filesystem identity or real user data.

## 6. Explicit release/publication/submission authorization

Two irreversible/external actions require explicit owner authorization at the moment they are performed:

### npm first publication

After all source/CI evidence is green:
1. build the immutable first-release tarball from the exact final release SHA;
2. verify its SHA-256;
3. publish **that exact tarball** interactively with owner npm 2FA;
4. verify public registry metadata;
5. on a clean Windows x64 machine run:
   - `npx @mecrod/connect@latest doctor`
   - `npx @mecrod/connect@latest remote --root C:\Users\Public\OperatorReviewerFixture\demo-project`

### OpenAI Submit for Review

Submit only after:
- final Mecord Connect production deployment is complete;
- publisher identity matches live legal pages;
- npm clean-machine proof passes;
- reviewer login/pairing passes;
- domain challenge is complete if issued;
- Scan Tools matches the 10-tool snapshot;
- real OAuth/revoke/reconnect proof passes;
- five positive + three negative reviewer cases reproduce;
- reviewer-accessible demo recording exists;
- final region availability is set to supported/global availability as intended.

# Not an additional owner gate

These are engineering/release tasks and must not be presented as extra owner decisions:

- code fixes and regression testing;
- source/evidence synchronization;
- CI, platform, npm-runtime and signing certification;
- public-page/source branding consistency;
- deployment scripting and rollback preparation;
- security/red-team tests;
- package/tarball inspection;
- release notes/reviewer packet preparation;
- stale-process cleanup;
- production preflight/health checks;
- MSIX/Store work, because it is outside Mecord Connect v1 scope.

Production must remain frozen until the six external gates above permit final publication/deployment/submission sequencing.
