# Operator Reviewer Auth — Production Execution Runbook

Status: prepared, not executed.
Purpose: provision the OpenAI reviewer identity without weakening authentication for normal users.
Production issuer: `https://auth.splcart.in`.
Reviewer fixture root: `C:\Users\Public\OperatorReviewerFixture\demo-project`.

## Non-negotiable safety rules

- Never reuse an administrator or personal account as the reviewer.
- Never commit the reviewer password, password hash, OTP/TOTP material, recovery codes, OAuth tokens, authorization codes, PKCE verifier, raw production config backup, or session cookies.
- Do not globally lower Authelia from two-factor to one-factor.
- Apply one-factor eligibility only to the dedicated `operator-reviewers` group and only through the ChatGPT OIDC client's custom authorization policy.
- Preserve a tested rollback copy before every production auth change.
- Do not edit production files in place until an offline candidate validates successfully.

## Phase A — Discover actual production mounts

The Operator repository intentionally does not contain the live Authelia configuration. On the production host, first identify the exact auth container and bind/volume mounts without dumping environment secret values.

Safe discovery examples:

```sh
docker ps --filter name=operator-auth --format '{{.ID}} {{.Names}} {{.Image}}'
docker inspect operator-auth --format '{{json .Mounts}}'
docker inspect operator-auth --format '{{json .Config.Cmd}}'
docker inspect operator-auth --format '{{json .Config.Entrypoint}}'
```

Record only container image/digest, mount destinations and configuration file paths. Do not copy `.Config.Env` into evidence.

## Phase B — Create rollback material outside Git

1. Resolve the mounted production `configuration.yml` and `users_database.yml`.
2. Copy both into a root/admin-only backup directory named with UTC timestamp.
3. Restrict backup permissions to the production administrator.
4. Compute SHA-256 for the pre-change files and record only the hashes plus backup timestamp in release evidence.
5. Confirm the backup can be read before editing any candidate.

Do not upload these backups to GitHub or attach them to the OpenAI submission.

## Phase C — Generate the reviewer password safely

Use Authelia's interactive Argon2 command so the password is not present in shell history or process arguments:

```sh
authelia crypto hash generate argon2
```

The current Authelia CLI defaults the Argon2 variant to `argon2id`. Enter and confirm a high-entropy reviewer password only at the interactive prompt.

If executing through the production container, use an interactive terminal and the installed Authelia binary. Do not use `--password <value>`.

Store:
- plaintext password: approved password manager / OpenAI reviewer credential field only;
- resulting hash: candidate `users_database.yml` only.

Do not put either value in certification Markdown or chat transcripts.

## Phase D — Build offline candidate files

Copy the production configuration and user database into a protected candidate directory. Apply only these semantic changes.

Reviewer user requirements:
- username: `operator-reviewer`;
- `disabled: false`;
- password: the new Argon2id digest;
- groups: exactly `operator-reviewers` unless the production schema requires another non-privileged baseline group;
- no administrator, infrastructure, billing, publisher, support-admin or device-admin group.

Authelia's file user database stores password hashes, not plaintext passwords. Preserve the production file's schema and required profile fields. Do not invent a privileged email/identity.

OIDC policy addition:

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

Only the ChatGPT/OpenAI Operator OIDC client should receive:

```yaml
authorization_policy: 'chatgpt_reviewer_policy'
```

All other clients keep their existing authorization policies. Because Authelia evaluates custom authorization-policy rules in order, keep the reviewer rule narrow and do not add a catch-all `one_factor` rule.

## Phase E — Validate before activation

Validate the **complete candidate**, not an isolated YAML fragment, with the same secret/config inputs and Authelia image/version used by production.

Current CLI form:

```sh
authelia config validate --config <candidate-configuration.yml>
```

If production uses multiple configuration files/directories, pass the same complete set to `--config`. If secrets are injected through files/environment, make the validation process receive the equivalent secret inputs without printing their values.

Also validate the user database structurally against the production Authelia version/schema. At minimum confirm:
- `operator-reviewer` appears once;
- password starts with an Argon2id digest marker;
- effective groups contain `operator-reviewers` and no privileged group;
- the existing administrator and ordinary-user records are byte-for-byte unchanged in the candidate.

Do not proceed on warnings/errors that affect OIDC, user-database parsing, secrets, sessions, or authorization policy.

### Current pre-activation validation evidence — 2026-09-18

Without creating a live reviewer account or password, the proposed `chatgpt_reviewer_policy` structure and the ChatGPT client's switch to that named policy were applied to an offline candidate cloned from the exact production configuration. Validation ran with the production Authelia 4.39.26 image, the same read-only config/secret mounts, the same secret-file environment wiring, and no network access. `authelia config validate` returned success.

A negative-control check proved that `authelia config validate` does **not** parse/validate the contents of the file-user database, so that command is not used as evidence for reviewer-user schema correctness. Separately, a disposable candidate cloned from the production `users_database.yml` was given a non-live reviewer test record with the intended non-privileged group/profile shape and validated against Authelia's published **v4.39 `user-database` JSON Schema**. That candidate passed. An intentionally malformed user database failed the same schema validator, proving the structural check is active rather than a no-op. No production user record, password or password hash was printed, committed or changed; the disposable candidate was deleted after validation.

Production authentication policy and users were not changed by these dry runs. H2 still requires a real high-entropy reviewer credential, production activation, one-factor behavior through the ChatGPT client, isolation checks and reviewer-fixture pairing.

## Phase F — Controlled production activation

1. Enter a maintenance window where an immediate auth rollback is possible.
2. Reconfirm the pre-change hashes and backup readability.
3. Atomically replace only the validated configuration/user-database files at their real mounted source paths.
4. Restart/recreate **only** the Authelia/Operator auth container or service required to reload those files.
5. Do not restart Operator edge, relay, database, or unrelated SPLCART services unless the deployment topology proves it is necessary.
6. Confirm the auth process becomes healthy and does not enter a restart loop.
7. Immediately fetch OIDC discovery/JWKS and verify issuer/endpoints remain unchanged.

Do not treat process start as success. Continue to the behavior checks below.

## Phase G — Authentication behavior checks

PASS requires all of these:

- an existing normal/admin account still follows its previous two-factor path;
- a user outside `operator-reviewers` cannot obtain one-factor access merely because the custom policy exists;
- `operator-reviewer` can authenticate to the **ChatGPT Operator client only** with the intended first factor and without TOTP/SMS/email confirmation;
- the reviewer cannot acquire administrator/support/publisher permissions;
- a bad reviewer password fails normally and regulation/rate-limit behavior remains active;
- disabling/removing the reviewer user prevents new authorization;
- Authelia discovery, JWKS, callback allowlist and S256 PKCE behavior remain unchanged.

Record pass/fail and UTC timestamps only; do not record cookies, tokens, codes, password values or OTP material.

## Phase H — Pair only the disposable reviewer fixture

Reset the canonical fixture before pairing:

```powershell
& 'C:\Users\Public\OperatorReviewerFixture\reset-fixture.ps1'
```

After the public npm runtime exists, start it with only the fixture root:

```powershell
npx @mecrod/operator@latest remote --root C:\Users\Public\OperatorReviewerFixture\demo-project
```

Claim the resulting one-time device code only while authenticated as the disposable reviewer. The reviewer account must not inherit or claim any real personal/project device.

Run the exact five positive and three negative cases in `plugin-review-package.json`. After the review window, revoke/remove the reviewer device authority and disable or remove the reviewer user unless an active OpenAI review still requires it.

## Phase I — Rollback

Rollback immediately if validation, discovery, normal-user 2FA, reviewer isolation, callback/OIDC behavior, or container health differs from the expected state.

Rollback procedure:
1. restore the exact pre-change configuration and user database from the protected backup;
2. restart/recreate only the auth service;
3. verify the original file hashes are restored;
4. verify normal 2FA and OIDC discovery again;
5. invalidate any reviewer session/device authority created during the failed attempt;
6. record the failed attempt and root cause without secret material.

Do not partially roll back only the user or only the policy; restore the known-good pair together.

## Evidence permitted in the certification repository

Allowed:
- Authelia image/version and non-secret configuration path;
- pre/post configuration SHA-256 hashes where the hashes do not expose file contents;
- sanitized structural diff showing policy/group names but no user hash/password/secret;
- `authelia config validate` PASS result;
- service health result;
- issuer/discovery/JWKS endpoint results;
- behavioral PASS/FAIL matrix;
- reviewer device fixture identifier only if it is already public-safe and non-secret;
- timestamps and rollback outcome.

Forbidden:
- plaintext reviewer password;
- password digest copied from the live users database;
- TOTP/WebAuthn/recovery material;
- OAuth access/refresh tokens or authorization codes;
- PKCE verifier;
- Authelia session/storage/OIDC secrets;
- raw production config backups;
- cookies or browser storage.

## Gate closure

H2 / FG-006 is not PASS merely because the configuration validates. Closure requires a real disposable reviewer login through the production ChatGPT client without secondary verification, isolation from normal/admin authority, pairing only to the canonical fixture, and successful execution of the submitted reviewer tests.

This runbook prepares that human-controlled production step; it does not claim it has occurred.
