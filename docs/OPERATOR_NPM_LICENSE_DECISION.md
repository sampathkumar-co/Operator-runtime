# Operator npm Software License Decision Memo

Status: decision support only — no software license has been applied. See `OPERATOR_OWNER_RELEASE_DECISION_PACKET.md` for the compact owner execution/decision record.
Review date: 2026-09-18.
Scope: public `@mecrod/operator` Windows runtime; this does not replace the hosted service Terms/Privacy documents.

## npm metadata requirement

Authoritative source: https://docs.npmjs.com/files/package.json/

npm documents `UNLICENSED` for private or unpublished software where the publisher does not grant others the right to use the package. For a custom license without an SPDX identifier, npm supports `license: "SEE LICENSE IN <filename>"` and requires the referenced file to be shipped at the package root.

Therefore the current `license: "UNLICENSED"` state is appropriate as a publication fail-safe but not as the final metadata for a runtime intended for public installation.

## Option A — Proprietary runtime license

Use a custom `LICENSE`/EULA and set:

```json
"license": "SEE LICENSE IN LICENSE"
```

Best fit when the commercial intent is: anyone may install and run the Operator runtime for authorized use with the SPLCART Operator service, while ownership, redistribution, resale, competing hosted use, modification/derivative distribution and circumvention rights remain reserved except where law requires otherwise.

Advantages:
- preserves commercial/control rights despite the repository being publicly readable;
- can explicitly bind permitted runtime use to authorized devices/accounts and the service safety model;
- avoids unintentionally granting broad fork/redistribution rights.

Costs:
- custom legal text needs owner/legal review;
- it is source-visible/proprietary, not open source;
- third-party reuse and ecosystem contributions are more constrained.

## Option B — Apache-2.0

Use SPDX metadata `"license": "Apache-2.0"` and ship the Apache 2.0 license text.

Best fit when the goal is an open-source runtime with broad commercial reuse plus an explicit patent license. Third parties may copy, modify, redistribute and commercially reuse the runtime under the license conditions.

## Option C — MIT

Use SPDX metadata `"license": "MIT"` and ship the MIT license text.

Best fit when the goal is the simplest permissive open-source adoption model. It is easy for developers to reuse, fork and redistribute, including commercially.

## Engineering/commercial fit recommendation

For the current Operator architecture, the **proprietary custom runtime license is the closer fit** if the intent is to distribute a free local connector for the hosted Operator service without granting broad rights to repackage or commercialize the runtime independently. The public GitHub repository can remain source-visible while the runtime itself is not open source.

If the actual strategy is to encourage third-party forks, integrations and independent reuse, Apache-2.0 is the stronger open-source default because it includes an explicit patent grant. MIT is the lightest-weight alternative when maximum simplicity matters more than patent-language coverage.

This memo does not supply final legal wording. `OPERATOR_PROPRIETARY_RUNTIME_LICENSE_DRAFT.md` contains a non-effective proprietary runtime license draft to accelerate owner/legal review. It must not be shipped until the Licensor identity, governing law, liability cap, required exceptions and final business terms are approved and all draft markers are removed.

## Required implementation after decision

1. Replace `UNLICENSED` in `packages/mecrod-operator/package.json` with the selected SPDX expression or `SEE LICENSE IN LICENSE`.
2. Add the selected `LICENSE` at the published package root.
3. Ensure `npm pack --json` contains the exact license file; PR #22 already fail-closes if it is missing.
4. Add a short license notice/link to the package README, completing FG-014.
5. Re-run exact-source CI, NPM Remote Runtime CI, Signing Smoke, tarball install/doctor, secret scan and clean-machine verification on the final successor SHA.
6. Record the owner decision and approval date in release evidence before npm publication.
