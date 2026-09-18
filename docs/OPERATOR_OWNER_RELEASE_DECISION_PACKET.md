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
- **npm package:** @mecrod/connect
- **npm account:** not created yet
- **Availability:** global wherever supported and legally/service-operationally supportable
- **v1 public domain:** operator.splcart.in
- **Auth issuer:** auth.splcart.in
- **Windows Store/MSIX:** not required for Mecord Connect v1; retain as a separate optional/future distribution lane, not a v1 submission gate
- **OpenAI account:** owner/admin access exists, but publisher/developer submission verification/login has not yet been completed
- **Reviewer credential:** provisioned; owner-side login/pairing verification remains required because certification tooling will not retrieve/expose the password

## Final owner-decision source certification

Current integrated PR #27 head: `c5cc9dd3156b857b51a0e35cafff346c1ca8d906`

Exact-head certification: **CI #757 PASS / Platform Matrix #527 PASS / NPM Remote Runtime #167 PASS / Windows Signing Smoke #528 PASS**.

## Applied source state

Integrated PR #27 now applies these decisions in source:

- npm package renamed from @mecrod/operator to **@mecrod/connect**;
- package folder renamed to packages/mecrod-connect;
- npm bin shim renamed to **mecord-connect**;
- package metadata uses **SEE LICENSE IN LICENSE**;
- package-root proprietary **LICENSE** is present;
- package-root **DISCLOSURE** is present;
- package metadata requires `contentPolicy.class = "dual-use"`;
- package author is **Kinthala Samuel Sampath Kumar** with support@splcart.in;
- release guards fail closed if the package name, proprietary license, dual-use declaration, disclosure or publisher identity is changed/removed;
- npm CI certifies the packed LICENSE/DISCLOSURE, installed @mecrod/connect runtime and mecord-connect.cmd shim;
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

## npm account actions still required

No npm account currently exists for the owner.

Do not create or publish with guessed credentials.

Owner/account actions:
1. create/sign into the intended npm account;
2. enable 2FA;
3. obtain/control the `@mecrod` scope (organization if required and available);
4. confirm the account is authorized to publish `@mecrod/connect`;
5. build the immutable first-release artifact from the final green release SHA;
6. verify its SHA-256;
7. publish **that exact tarball** interactively with 2FA;
8. verify registry metadata;
9. from a clean Windows x64 machine run `npx @mecrod/connect@latest doctor`;
10. run `npx @mecrod/connect@latest remote --root C:\Users\Public\OperatorReviewerFixture\demo-project`;
11. after the package exists, retain the staged/human-approval path for subsequent dual-use releases.

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
