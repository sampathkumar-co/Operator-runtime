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

PASS evidence: verified publisher identity + permission to create/edit an MCP plugin draft.

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
2. run `authelia validate-config` against the complete candidate configuration;
3. restart only `operator-auth`;
4. verify issuer discovery and login still work;
5. verify the admin path still requires its normal stronger policy;
6. verify the reviewer can authorize the ChatGPT client with username/password only.

PASS evidence: disposable reviewer credentials complete the submitted tests without secondary verification.
## H3 — Create or reconcile the OpenAI MCP plugin draft

Use the production server URL `https://operator.splcart.in/mcp`. Select the predefined OAuth-client path.

Current production client configuration is:

- callback currently allowlisted: `https://chatgpt.com/connector/oauth/8HymKNOT2aqK`
- public client; token endpoint auth method `none`
- PKCE required, S256 only
- requested scopes: `operator:read operator:write` plus OIDC/offline scopes as required by the provider
- resource/audience: `https://operator.splcart.in/mcp`
- authorization-code and refresh-token grants

The callback shown by the OpenAI app-management page is authoritative. If a new draft displays a different callback ID, update the predefined client allowlist before continuing; do not assume the existing callback ID will be reused.

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
5. `file.read` + `file.replace` using the fresh SHA-256;
6. `.env` / credential-path refusal;
7. outside-authorized-root refusal;
8. read-only-token mutation refusal.

For the write cases independently verify the local filesystem/Git postcondition. For every case confirm the public result excludes relay tokens, device private material, provider diagnostics and unnecessary host identifiers.

## H8 — Submit

Before selecting **Submit for Review**, confirm:

- publisher identity is verified;
- Apps Management write permission is present;
- reviewer credentials work without MFA/SMS/email confirmation/private network;
- the portal domain check (if requested) is complete;
- Scan Tools matches the expected ten-tool snapshot;
- all five positive and three negative cases are reproducible;
- website/privacy/terms/support are the live OCC-3M pages;
- country availability is limited to regions actually supported by the publisher/legal/support process;
- release notes describe this as the initial public submission.

Do not mark Operator `CONFIRMED FOR RELEASE` until G10, G11, G23, G24, G25 and G26 in `OPERATOR_RELEASE_GATE.md` are all PASS.
