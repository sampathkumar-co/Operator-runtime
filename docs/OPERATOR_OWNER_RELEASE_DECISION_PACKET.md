# Operator Owner Release Decision Packet

Status date: 2026-09-18
Purpose: reduce FG-013 / FG-015 to explicit owner decisions without changing or publishing the certified runtime.

## Frozen engineering state

- Production/main: OCC-3M `405be7a03270c6c7ced78cd0d0d58314048a1af7`.
- Frozen npm-hardening draft: PR #22 head `bbcc12a7b5167345ab865af3f6c230580a2eda37`.
- PR #22 exact-head validation: CI #700 PASS, Platform Matrix #470 PASS, NPM Remote Runtime CI #128 PASS, Windows Signing Smoke #471 PASS.
- Local Windows-aware suite: 367 tests / 351 pass / 16 expected skips / 0 fail.
- Targeted release/policy suite: 18/18 PASS.
- `@mecrod/operator@1.0.0` is not published.
- This Windows machine is not authenticated to npm (`npm whoami -> ENEEDAUTH`).
- The current public npm org lookup for `mecrod` returns 404 / `Scope not found`. Treat this only as a public signal; it does not prove the intended owner can claim the namespace.

No choice below authorizes publication by itself.

## Decision 1 — software license (FG-013)

Choose exactly one.

### A. Proprietary runtime license

Use when the intent is to let users install/run Operator while retaining control over redistribution, competing hosted use and derivative distribution.

Required owner/legal fields before activation:
- exact Licensor legal person/entity;
- legal/contact address or approved contact;
- governing law;
- forum/dispute mechanism;
- aggregate liability cap;
- mandatory-law / non-excludable-liability exceptions;
- confirmation that the grant/restrictions match the intended business model.

Engineering changes after approval:
1. finalize `OPERATOR_PROPRIETARY_RUNTIME_LICENSE_DRAFT.md`;
2. remove every draft marker/placeholder;
3. copy approved text to package-root `LICENSE`;
4. set package metadata to `"license": "SEE LICENSE IN LICENSE"`;
5. add a short README license notice.

Do not activate this option from the existing draft without owner/legal approval.

### B. Apache-2.0

Use when broad third-party reuse, modification and redistribution are intended and an explicit patent grant is desired.

Engineering changes:
1. add canonical Apache-2.0 text as package-root `LICENSE`;
2. set `"license": "Apache-2.0"`;
3. add README license notice.

### C. MIT

Use when broad permissive reuse is intended with the simplest common license.

Engineering changes:
1. add canonical MIT text as package-root `LICENSE`;
2. set `"license": "MIT"`;
3. add README license notice.

## Decision 2 — npm Dual-Use Content Policy (FG-015)

Choose exactly one outcome.

### A. DUAL_USE

Conservative engineering path for Operator's shipped remote-computer/runtime capabilities.

Engineering changes:
1. add:
   ```json
   "contentPolicy": {
     "class": "dual-use"
   }
   ```
2. promote the reviewed disclosure draft to package-root `DISCLOSURE`;
3. retain the declaration in every future published version unless npm Trust & Safety approves removal;
4. first publication remains interactive with 2FA;
5. future automation remains stage-only, followed by human 2FA promotion.

PR #22 already proves `DISCLOSURE` can enter the tarball and fails closed if a declared dual-use tarball omits it.

### B. NOT_DUAL_USE

Use only if the owner accepts the documented rationale that Operator is a user-authorized developer automation/runtime product rather than a security-research, exploit, evasion or malware tool.

Engineering/evidence changes:
1. do not add `contentPolicy` or `DISCLOSURE`;
2. record the owner decision and rationale in release evidence;
3. keep the hardened artifact-first / stage-only future release machinery anyway.

### C. NPM_CONFIRMATION

Ask npm Trust & Safety / policy support for a determination and retain only the non-secret ticket/correspondence reference in evidence.

Engineering changes follow npm's written classification direction.

## Lower-regret engineering combination

If the commercial intent is a controlled connector for the hosted Operator service rather than an open-source ecosystem package, the existing engineering memos identify **Proprietary + DUAL_USE** as the conservative combination.

This is a decision-support recommendation only. It is not an applied license or policy classification.

## Decision 3 — exact publisher legal identity (FG-017)

This is not inferred from GitHub/npm account names or the SPLCART brand.

Owner must provide/approve:
- exact legal person/entity that operates and publishes Operator;
- governing jurisdiction/country/state as applicable;
- approved public legal/support contact identity;
- whether that same person/entity is the proprietary Runtime License Licensor if the proprietary path is selected.

After approval:
1. patch the Operator canonical notices in `deploy/public-edge/production-notices/privacy.md`, `terms.md`, and `support.md` (live equivalents currently reside under `/home/deploy/operator/ops/production-notices/`);
2. patch SPLCART storefront legal/identity content in `frontend-new/src/lib/trust-content.ts` and `frontend-new/src/components/trust/PublicContentPage.tsx` so it no longer contains unresolved actual-business-entity/jurisdiction or unpublished-support wording;
3. use the same identity in OpenAI publisher verification;
4. use the same Licensor identity in the proprietary package license if applicable;
5. verify the live public pages before submission.

Do not invent the publisher identity from repository owners, email usernames, account profile names, or domain WHOIS guesses.

## What happens immediately after the owner decisions

Applying either decision changes the source SHA, so PR #22's current green SHA stops being the final successor.

The resulting successor must rerun at minimum:

1. candidate identity / clean worktree / exact source binding;
2. package metadata validation;
3. `npm pack --json` and tarball inventory;
4. required `LICENSE` verification;
5. conditional `DISCLOSURE` verification;
6. npm policy-continuity tests;
7. NPM Remote Runtime CI;
8. full CI;
9. Platform Matrix;
10. Windows Signing Smoke;
11. tarball install + `doctor`;
12. full Windows-aware regression suite;
13. secret-like scan;
14. public/legal truthfulness review;
15. clean-machine verification after first publication.

Do not merge or publish merely because the metadata patch is small.

## npm namespace / first publish owner action

The engineering side cannot complete this without an authenticated owner session.

Owner sequence:
1. sign in to the intended npm publisher account and enable 2FA;
2. verify whether organization `mecrod` can be created/claimed by that account;
3. if available, create/verify the org and confirm owner/admin role;
4. rerun:
   ```powershell
   npm whoami
   npm org ls mecrod --json
   ```
5. after the final successor is green, build the immutable first-release artifact;
6. recompute/compare SHA-256;
7. publish that exact `.tgz` interactively with 2FA;
8. verify registry metadata and run clean-machine `npx @mecrod/operator@latest doctor`;
9. only after the package exists, configure trusted publishing with stage-only permission and human 2FA promotion.

Never store npm password, session token, OTP or recovery codes in Git, evidence Markdown or chat.

## Minimal owner response needed

To unblock engineering, record these items:

- **License:** `PROPRIETARY` / `APACHE-2.0` / `MIT`
- **npm policy:** `DUAL_USE` / `NOT_DUAL_USE` / `NPM_CONFIRMATION`
- **Publisher legal identity:** exact person/entity name
- **Jurisdiction:** country/state or other legally appropriate governing jurisdiction
- **Public legal/support contact identity:** approved contact/name/address as applicable

If `PROPRIETARY` is selected, the liability/dispute fields listed above must also be approved before the license becomes effective.
