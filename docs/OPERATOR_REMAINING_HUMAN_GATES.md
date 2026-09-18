# Operator Remaining Human / OpenAI Portal Gates

This runbook starts from production candidate OCC-3M:

- source: `405be7a03270c6c7ced78cd0d0d58314048a1af7`
- production image: `sha256:7f1114f7f78843db9bf1f8ea7d94baf1a9914bbe42f07d2fbea67db980aaec18`
- MCP URL: `https://operator.splcart.in/mcp`
- auth issuer: `https://auth.splcart.in`
- public MCP surface: exactly 10 tools

Do not change runtime code while completing these gates. Any runtime/code change creates a new release candidate and requires affected re-certification.

## H1 — OpenAI Platform access and publisher identity

1. Use an OpenAI Platform organization/project with global data residency for the MCP submission.
2. Confirm the submitter has Apps Management write access (`api.apps.write`) and read access to inspect drafts/review state.
3. Complete individual/business verification using the exact publisher identity that will appear in the listing.
4. Confirm the public website, support contact, privacy policy and terms identify that same publisher consistently.

Current public preflight found a blocker that must be resolved before H1 can pass: Operator Privacy/Terms refer only to "the publisher of splcart.in"; SPLCART's own Terms say they still require review against the actual business entity/jurisdiction; and the SPLCART Contact page states that direct support details are not currently published. Operator itself does publish `support@splcart.in`, but no exact legal publisher person/entity is named. Do not infer that identity from repository/account names.

PASS evidence: the exact verified publisher legal identity is named consistently in the public legal/support materials and the submitter has permission to create/edit the MCP plugin draft.

## H2 — Dedicated reviewer identity

OpenAI requires demo credentials that work without MFA, SMS, email confirmation or private-network access. Never reuse the production administrator account for review.
Recommended Authelia design:

```yaml
identity_providers:
  oidc:
    authorization_policies:
      chatgpt_reviewer_policy:
        default_policy: 'two_factor'
        rules:
          - policy: 'one_factor'
            subject: 'group:operator-reviewers'
```

Set only the ChatGPT client `authorization_policy` to `chatgpt_reviewer_policy`. Normal users therefore remain two-factor; only the dedicated reviewer group is eligible for one-factor authorization.

Create an `operator-reviewer` user in `/config/users_database.yml` with no administrative group and only `operator-reviewers`. Generate a high-entropy password and Argon2id digest with the official Authelia password-hash tooling. Store the plaintext only in the approved password manager / OpenAI reviewer credential field; never commit it, paste it into evidence, or log it.

Before activating the change:

1. back up `configuration.yml` and `users_database.yml`;
2. run `authelia config validate --config <candidate-configuration.yml>` against the complete candidate configuration using the same environment/secret inputs as production;
3. restart only `operator-auth`;
4. verify issuer discovery and login still work;
5. verify the admin path still requires its normal stronger policy;
6. verify the reviewer can authorize the ChatGPT client with username/password only.

Execute `OPERATOR_REVIEWER_AUTH_EXECUTION.md` for the production-safe backup, candidate validation, activation, isolation and rollback sequence. The repository intentionally does not contain the live Authelia production configuration, so do not invent or commit a production config patch here.

Pre-activation evidence proves the custom reviewer authorization-policy candidate validates against production Authelia 4.39.26 and a disposable reviewer user record passes Authelia's published v4.39 user-database schema with a rejecting negative control.

**Current production state:** a dedicated reviewer account and reviewer-only one-factor authorization policy have now been provisioned. Authelia restarted healthy and normal users retain the policy default of two-factor. The generated reviewer password was not exposed to Git/chat and has not been consumed by this certification agent because credential-handling was blocked by the safety layer. Owner retrieval/login verification and pairing remain required.

PASS evidence: the provisioned reviewer credential completes the submitted tests without secondary verification and is paired only to the canonical reviewer fixture.

## H3 — Create or reconcile the OpenAI MCP plugin draft

Use the production server URL `https://operator.splcart.in/mcp`. Select the predefined OAuth-client path.

Current production client configuration is:

- redirect URIs currently allowlisted:
  - `https://chatgpt.com/connector_platform_oauth_redirect`
  - `https://chatgpt.com/connector/oauth/8HymKNOT2aqK`
- the authorization server advertises `authorization_response_iss_parameter_supported: true`, so current OpenAI flows may select the stable redirect; the app-management page remains authoritative
- public client; token endpoint auth method `none`
- PKCE required, S256 only
- requested scopes: `operator:read operator:write` plus OIDC/offline scopes as required by the provider
- resource/audience: `https://operator.splcart.in/mcp`
- authorization-code and refresh-token grants

The redirect URI shown by the OpenAI app-management page is authoritative. If a future draft displays a different redirect URI, update the predefined-client allowlist and validate it before continuing; do not assume either the stable URI or the existing callback-ID URI will always be selected.

Current discovery also advertises `https://auth.splcart.in/api/oidc/userinfo`, the `openid` and `email` scopes, and both `email` and `email_verified` claims. That satisfies the discovery-side prerequisites OpenAI documents for optional workspace domain restrictions; actual authenticated UserInfo behavior should be verified during the real OAuth flow if that restriction is enabled for the submission.

## H4 — Complete the real OAuth proof

From the draft, authorize the reviewer account. Retain only non-secret evidence.

PASS requires all of the following:

1. authorization uses S256 PKCE and the exact portal callback;
2. the authorization request contains `resource=https://operator.splcart.in/mcp`;
3. the token request carries the same resource value;
4. the issued access token verifies against `https://auth.splcart.in/jwks.json`;
5. `iss` is exactly `https://auth.splcart.in`;
6. `aud` (or equivalent resource claim) is exactly `https://operator.splcart.in/mcp`;
7. required scopes are present and an expired/wrong-audience/wrong-scope token is rejected;
8. a valid token can initialize `/mcp`.
Never copy the access token, refresh token, authorization code, password or PKCE verifier into the certification repository.

## H5 — Domain verification token

OCC-3M already supports the route. The exact environment variable is `OPENAI_APPS_CHALLENGE_TOKEN` and the server rejects values over 2048 bytes or containing NUL/CR/LF.

Until OpenAI supplies a real token, `/.well-known/openai-apps-challenge` must remain 404. When the portal issues a token:

1. put only that exact value into the production `operator-edge.env` as `OPENAI_APPS_CHALLENGE_TOKEN`;
2. recreate only `operator-edge` and the network-sharing `operator-gateway` sidecar so the environment is reloaded;
3. verify the well-known URL returns exactly the portal token with `Cache-Control: no-store`;
4. complete the portal verification;
5. retain only the fact/time of verification, not the token itself, in evidence.

No source rebuild is required for this step.

## Reviewer fixture already prepared

The non-sensitive reviewer fixture is staged locally at baseline commit `ab658c353fc3e0ce79d71e2968f53eedbc247537`. `C:\Users\Public\OperatorReviewerFixture\reset-fixture.ps1` restores the exact submitted-test state. The authorized root is `C:\Users\Public\OperatorReviewerFixture\demo-project`, and the negative outside-root fixture is exactly `C:\Users\Public\outside-project.txt`.

Local certification on Node 22.23.2, through the production `invokePublicWithAgent` safety boundary and an isolated local agent, passes all submitted five positive and three negative reviewer cases. Additional assertions prove `file.replace` returns `APPROVAL_REQUIRED` without local one-time approval and duplicate `file.create` returns `TARGET_EXISTS`.

Keep positive #5 as bounded `git.diff`. Do not change it back to destructive `file.replace`: that action intentionally requires local approval and remains an internal security demonstration rather than a self-service reviewer success case. This local pass does not replace production OAuth, device pairing, or real ChatGPT E2E.

## H6 — Scan Tools reconciliation

Run **Scan Tools** against the exact production MCP URL after OAuth is configured in the draft. OpenAI imports server-advertised metadata; reviewer prose does not override it.

Expected snapshot:

- exactly 10 public tools;
- every tool has a title, description and bounded input schema;
- read tools require `operator:read`;
- mutating tools require both `operator:read` and `operator:write`;
- every tool has accurate `readOnlyHint`, `openWorldHint` and `destructiveHint` values;
- no private terminal/browser/UIA/PostgreSQL capability appears.
Compare the portal snapshot against `PUBLIC_PLUGIN_TOOL_NAMES` and `docs/plugin-review-package.json`. Any mismatch is a blocker: fix the server, deploy a new candidate if runtime code changed, then Scan Tools again.

## H7 — Real ChatGPT end-to-end certification

Run from the connected draft using only the disposable reviewer fixture:

1. `project.inspect` on the authorized demo project;
2. `file.read` on the safe fixture;
3. `git.status` on the demo repository;
4. `file.create` on a previously absent disposable file;
5. `git.diff` on `src/known-modified.ts`;
6. `.env` / credential-path refusal;
7. `C:/Users/Public/outside-project.txt` outside-authorized-root refusal;
8. read-only-token mutation refusal.

Optionally request `file.replace` only as a policy demonstration and expect `APPROVAL_REQUIRED` unless a local owner intentionally grants the one-time approval.

For the write cases independently verify the local filesystem/Git postcondition. For every case confirm the public result excludes relay tokens, device private material, provider diagnostics and unnecessary host identifiers.

## H8 — Resolve npm licensing and publish the clean-machine runtime

Use `OPERATOR_OWNER_RELEASE_DECISION_PACKET.md` as the compact owner decision record for FG-013/FG-015 before modifying PR #22.

The registry currently returns E404 for `@mecrod/operator`; version `1.0.0` is not public yet. The current package also declares `license: UNLICENSED`, the public repository has no license file, and the hosted service Terms do not explicitly grant software installation/use rights. Do not publish until the owner chooses the runtime licensing model.

If distribution is proprietary, add an owner-approved software license/EULA and set `license` to `SEE LICENSE IN <filename>`. If distribution is open source, choose the intended SPDX license and add that license file. Do not infer this business/legal choice from the codebase.

Before choosing the npm publish mechanism, classify the package against npm's current Dual-Use Content Policy. The policy examples are non-exhaustive; because Operator ships security-sensitive remote-computer automation, do not assume either classification. If declared dual-use, add `contentPolicy.class: dual-use` plus a root `DISCLOSURE`, and use interactive 2FA or staged publishing with 2FA promotion. Direct trusted-publishing/OIDC or bypass-2FA publication is not permitted for declared dual-use packages. If the owner concludes it is not dual-use, retain the rationale in release evidence.

Any license/package metadata edit changes the source SHA. Treat the result as a successor candidate to OCC-3M and rerun at minimum candidate identity, package/tarball inspection, supply-chain checks, package smoke install/doctor, clean-machine startup, legal/public-truthfulness review, and final publication-source binding.

Draft PR #22 implements the policy-neutral release machinery at head `bbcc12a7b5167345ab865af3f6c230580a2eda37`: first-release artifact handoff, exact-tarball staging for later versions, `UNLICENSED` fail-closed behavior, shipped-license verification, root `DISCLOSURE` packaging/enforcement, and continuity protection across a bounded full npm published-version history. Registry package identity, versions-map shape and unknown historical policy classes fail closed. CI #700, Platform Matrix #470, NPM Runtime #128 and Signing Smoke #471 all pass on that exact head; GitHub's NPM Runtime logs confirm the new continuity cases executed, local targeted release/policy tests are 18/18 PASS, the full Windows-aware suite is 367 tests / 351 pass / 16 expected skips / 0 failures, both owner-selectable packaging shapes were simulated successfully, and npm 11.19.1 accepted the exact local tarball form in stage dry-run. `OPERATOR_NPM_NAMESPACE_BOOTSTRAP.md` remains the owner checklist for proving/creating the `mecrod` npm organization, enforcing 2FA, publishing the exact first tarball and retaining non-secret evidence. Keep the PR draft until the owner decisions below are applied and the resulting final successor is re-certified.

Approved publication path after that successor is green:

1. configure an npm publisher that controls the `@mecrod` user/organization scope and has 2FA enabled;
2. because npm requires a package to already exist before `npm stage` can be used, the successor workflow must build/hash/upload the exact first-release tarball without publishing it;
3. after reviewing the CI artifact/hash, the owner publishes that exact tarball interactively with 2FA. This first-release path is compatible with both ordinary and declared dual-use packages;
4. after `@mecrod/operator` exists, configure npm Trusted Publishing for this repository/workflow with stage-only permission and use `npm stage publish` for future versions, followed by human 2FA approval;
5. require the workflow to pass the release-source gate, locked native-helper builds/self-tests, runtime payload build, tarball install/doctor, duplicate-version refusal, final source-binding check and the applicable artifact-handoff or staged-publication path;
6. from a clean Windows x64 machine verify `npx @mecrod/operator@latest doctor`;
7. start `npx @mecrod/operator@latest remote --root C:\Users\Public\OperatorReviewerFixture\demo-project` and confirm the pairing code/relay path;
8. after the first package exists, set package access to require 2FA/disallow token publishing where supported, keep the trusted publisher limited to `npm stage publish`, and require human 2FA promotion for future releases.

Public npm publication is an external release action and must be explicitly authorized by the owner before dispatch.

## H9 — Submit

Before selecting **Submit for Review**, confirm:

- publisher identity is verified;
- Apps Management write permission is present;
- reviewer credentials work without MFA/SMS/email confirmation/private network;
- the portal domain check (if requested) is complete;
- Scan Tools matches the expected ten-tool snapshot;
- all five positive and three negative cases are reproducible;
- website/privacy/terms/support are the live OCC-3M pages;
- country availability is limited to regions actually supported by the publisher/legal/support process;
- release notes describe this as the initial public submission;
- the final successor contains the required `interface.logo` and `interface.composerIcon` branding assets (draft PR #26 currently supplies them);
- `OPERATOR_DEMO_RECORDING_RUNBOOK.md` has been executed and a reviewer-accessible demo recording URL exists that demonstrates the real production ChatGPT/OAuth/MCP path without exposing credentials, tokens, private keys, personal filesystem identity or real user data.

Do not mark Operator `CONFIRMED FOR RELEASE` until G10, G11, G19, G22, G23, G24, G25 and G26 in `OPERATOR_RELEASE_GATE.md` are all PASS.
