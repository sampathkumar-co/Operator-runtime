# Mecord Connect Owner Release Decisions

Status date: 2026-09-18

Purpose: authoritative record of the owner decisions that previously blocked FG-013, FG-015 and the owner-input portion of FG-017.

## Supplied owner decisions

- **Product name:** Mecord Connect
- **Publisher type:** Individual
- **Publisher legal name for source/public metadata:** Kinthala Samuel Sampath Kumar
- **Verification caveat:** before OpenAI publisher verification/submission, the spelling/order must match the identity document and the exact name accepted by OpenAI. If OpenAI verifies a different legal spelling/order, reconcile the source/public metadata before submission.
- **Public locality:** Akkayapalem, Visakhapatnam, Andhra Pradesh, India
- **Public support:** support@splcart.in
- **Governing law:** India
- **Dispute venue:** competent courts at Visakhapatnam, Andhra Pradesh, subject to mandatory consumer-protection/jurisdiction rules
- **Software license:** PROPRIETARY
- **npm Dual-Use classification:** DUAL_USE
- **npm package:** mecord-connect
- **npm account:** **mecrod** ? authenticated locally
- **Availability:** global wherever supported and legally/service-operationally supportable
- **v1 public domain:** operator.splcart.in
- **Auth issuer:** auth.splcart.in
- **Windows Store/MSIX:** not required for Mecord Connect v1; retain as a separate optional/future distribution lane, not a v1 submission gate
- **OpenAI account:** owner/admin access exists, but publisher/developer submission verification/login has not yet been completed
- **Reviewer credential:** provisioned; owner-side login/pairing verification remains required because certification tooling will not retrieve/expose the password

## Final owner-decision source certification

Current integrated PR #27 head: `11abc578488f5deb4df83299554b6a4eae3bbe2e`

Exact-head certification: **CI #765 PASS / Platform Matrix #535 PASS / NPM Remote Runtime #174 PASS / Windows Signing Smoke #536 PASS**.

## Applied source state

Integrated PR #27 now applies these decisions in source:

- npm package renamed from @mecrod/operator to **mecord-connect**;
- package folder renamed to packages/mecord-connect;
- npm bin shim renamed to **mecord-connect**;
- package metadata uses **SEE LICENSE IN LICENSE**;
- package-root proprietary **LICENSE** is present;
- package-root **DISCLOSURE** is present;
- package metadata requires `contentPolicy.class = "dual-use"`;
- package author is **Kinthala Samuel Sampath Kumar** with support@splcart.in;
- release guards fail closed if the package name, proprietary license, dual-use declaration, disclosure or publisher identity is changed/removed;
- npm CI certifies the packed LICENSE/DISCLOSURE, installed mecord-connect runtime and mecord-connect.cmd shim;
- plugin manifest `author.name` / `interface.developerName` use the individual publisher identity;
- source-controlled Privacy/Terms/Support pages identify the individual publisher and India/Visakhapatnam jurisdiction while retaining Mecord Connect as the product name;
- operator.splcart.in remains the v1 public endpoint.

## License decision — PROPRIETARY

The proprietary choice is intentional because Mecord Connect is presently a controlled connector/runtime for a hosted service rather than a general-purpose open-source redistribution project.

The package license grants limited authorized use while restricting redistribution/sublicensing and attempts to bypass security boundaries, subject to applicable law.

This decision does not make the repository broadly open source.

## npm policy decision — DUAL_USE

Mecord Connect intentionally uses the conservative npm classification because the shipped runtime contains security-relevant remote-management capabilities even though the public ChatGPT plugin exposes a much narrower surface.

The release machinery therefore requires:
- `contentPolicy.class = "dual-use"`;
- root `DISCLOSURE`;
- immutable first-release artifact;
- interactive human npm publication with 2FA for the first release;
- staged future releases with human 2FA promotion where applicable;
- continuity checks so the declaration cannot silently disappear.

## Publisher identity

The product brand is **Mecord Connect**.

The publisher/developer identity is **Kinthala Samuel Sampath Kumar**.

Do not replace the legal publisher identity with “Mecord Connect” or “SPLCART” in fields that are meant to identify the verified individual.

Before final OpenAI submission:
1. complete individual publisher verification;
2. compare the exact verified name with the source/public legal name;
3. reconcile any identity-document spelling/order difference before submission;
4. deploy the final legal pages and verify the live website/support/privacy/terms match.

## npm account / 2FA status

npm setup is now resolved and independently verified on the owner machine:

- `npm whoami` -> **mecrod**
- npm 2FA mode -> **auth-and-writes**
- package -> **mecord-connect** (unscoped; no npm organization/scope required)
- registry -> unpublished before first release

The remaining npm work belongs to the explicit irreversible release gate: build/hash the exact final tarball, obtain owner publication authorization, publish that exact tarball with 2FA, verify registry metadata, then run clean-machine `npx mecord-connect@latest doctor` and reviewer-root startup.

## OpenAI account actions still required

- login to the real publisher/developer submission account;
- complete individual publisher identity verification;
- create/reconcile the Mecord Connect plugin draft;
- use the current production MCP/OAuth endpoints;
- complete a portal-issued domain challenge if one is issued;
- run Scan Tools and verify the exact 10-tool public snapshot;
- execute real ChatGPT OAuth read/write/refusal/revoke/reconnect testing;
- enter reviewer credentials without secondary verification;
- record and host the required production demo;
- select global availability only where OpenAI supports the listing and the service can legally/operationally support users;
- submit only after final deployment and every release gate is green.

## Domain and Store decisions

For v1, keep:
- https://operator.splcart.in
- https://auth.splcart.in

A later Mecord-branded domain migration can be considered after usage/revenue justifies the OAuth/resource/domain-verification migration cost.

MSIX/Windows Store distribution is **not required for Mecord Connect v1**. Existing Store packaging/tests may remain as an optional/future engineering lane, but Store publication/name reservation is not a Mecord Connect v1 release prerequisite.
