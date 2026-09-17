# Operator npm Namespace / First-Publish Bootstrap

Status: owner-run checklist. No npm credentials are stored here.
Review date: 2026-09-18.
Target package: `@mecrod/operator@1.0.0`.

## What is known

- The public registry currently returns E404 for `@mecrod/operator@1.0.0`.
- Public web/registry search did not surface an existing `@mecrod/*` package or obvious public npm org/user result.
- Absence from public search does **not** prove the `mecrod` npm organization/scope is available or owned by the Operator publisher.
- npm grants an organization a scope matching its organization name, so organization `mecrod` owns namespace `@mecrod`.

## Owner bootstrap procedure

1. Sign in to the intended npm publisher account interactively.
2. Enable account 2FA before any organization/package governance action.
3. In npmjs.com, verify whether organization `mecrod` already exists under the account. If it does not exist and the name is available, create it using the public-packages/free organization option.
4. Require 2FA for organization members before adding any additional publisher.
5. Verify organization membership/role from an authenticated CLI with:

```powershell
npm whoami
npm org ls mecrod --json
```

6. Confirm the authenticated owner/admin identity appears and has authority to publish/manage packages in the organization.
7. Do **not** create a bypass-2FA automation token for the first release. PR #22 is designed to build the immutable artifact without registry credentials; the first publish is owner-controlled and interactive with 2FA.

## First publication evidence

After FG-013 licensing and FG-015 policy classification are resolved on the final successor SHA:

1. run the green release workflow in `artifact` mode on exact green `main`;
2. download the workflow artifact containing the `.tgz` and `.sha256` file;
3. independently recompute SHA-256 and compare it with the workflow checksum;
4. inspect the tarball contents, including `LICENSE` and `DISCLOSURE` if dual-use is declared;
5. from the interactive 2FA-authenticated npm owner session, publish **that exact `.tgz`** as public with the intended `latest` tag;
6. immediately verify `npm view @mecrod/operator@1.0.0 version`, repository/homepage/license metadata and the public package page;
7. from a clean Windows x64 machine run `npx @mecrod/operator@latest doctor` and then the reviewer-root `remote` startup;
8. retain only non-secret evidence: npm username/org role, package/version, publish timestamp, tarball SHA-256, workflow run ID and verification outcomes. Never retain the session token, password, OTP or recovery codes.

## After the package exists

Configure npm Trusted Publishing for the exact GitHub repository/workflow with **stage-only** permission. Set package publishing access to require 2FA/disallow ordinary tokens where supported. Future versions should use `npm stage publish` followed by human 2FA promotion.

Useful verification commands after bootstrap:

```powershell
npm org ls mecrod --json
npm view @mecrod/operator version repository homepage license --json
npm owner ls @mecrod/operator
```

If `mecrod` is unavailable or owned by an unrelated party, stop publication and choose a new package scope/name before changing the codebase; do not attempt to impersonate or work around another namespace owner.
