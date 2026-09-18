# Operator npm Dual-Use Classification Decision Memo

Status: evidence memo only — no owner classification has been applied. See `OPERATOR_OWNER_RELEASE_DECISION_PACKET.md` for the compact owner execution/decision record.
Policy review date: 2026-09-18.
Candidate context: OCC-3M production baseline with draft OCC-3N package hardening in PR #22.

## Authoritative npm policy facts

Sources reviewed:
- https://docs.npmjs.com/policies/dual-use/
- https://docs.npmjs.com/staged-publishing/
- https://docs.npmjs.com/trusted-publishers/
- https://docs.npmjs.com/cli/v11/commands/npm-stage/

npm defines dual-use content as legitimate security-relevant capabilities that can resemble malicious software to automated scanning. Its examples include penetration-testing, security research and code-obfuscation tools, but npm states that the examples are illustrative rather than exhaustive.

A package classified as dual-use must include `contentPolicy.class = "dual-use"` in `package.json` and a root `DISCLOSURE` file describing the dual-use functionality and intended legitimate use. Once published with this declaration, npm says it must persist across versions unless npm Trust & Safety reviews removal.

For a declared dual-use package, publication must enforce 2FA. Interactive direct publication with 2FA is allowed. Trusted publishing/OIDC or bypass-2FA credentials may be used only for staging, followed by human 2FA promotion; direct OIDC publication is not permitted.

Staged publishing requires npm CLI 11.15+ and Node 22.14+. npm also states that the package must already exist on the registry, so it cannot bootstrap the first release.

## Operator capability evidence

The public npm runtime is not malware and is intended to connect a user-authorized Windows computer to Mecord Connect/ChatGPT. Its public MCP surface is deliberately restricted and does not expose generic terminal, browser or UIA tools directly to ChatGPT.

However, the shipped runtime contains security-sensitive machinery that automated scanners may reasonably associate with remote-administration or dual-use software: authenticated remote relay control, local filesystem/project mutation, Windows UI Automation sidecar code, DPAPI credential protection, path-authority enforcement, device pairing/claiming and managed browser support in the private runtime.

## Classification assessment

Evidence leaning toward dual-use:
- remote-computer control is central to the runtime's purpose;
- the package contains privileged/security-sensitive Windows helpers and remote session machinery;
- the package can cause local mutations on an authorized computer;
- npm explicitly says its examples are not exhaustive and focuses on security-relevant capabilities that can resemble malicious software to scanners.

Evidence against an automatic dual-use conclusion:
- Operator is primarily a user-authorized developer automation/runtime product, not a penetration-testing, exploit, evasion or security-research package;
- the public MCP surface removes raw terminal/browser/UIA exposure and enforces OAuth, device identity, local policy, authorized roots and approvals;
- no functionality is intended primarily to gain unauthorized access, evade detection, deploy malware or deliver exploits.

## Engineering recommendation

Conservative recommendation: **treat Operator as dual-use for npm publication unless npm Trust & Safety confirms that this remote-administration/developer-automation runtime does not require the declaration.** This is the lower-regret engineering posture because declaration is permitted and aligns the release path with mandatory human 2FA, while a missed required declaration could block or delay publication.

This recommendation is not a legal conclusion and is not applied automatically. The owner may instead retain a documented non-dual-use rationale or ask npm policy support for an explicit determination before first publication.

`OPERATOR_NPM_DISCLOSURE_DRAFT.md` contains a ready, non-active `DISCLOSURE` draft that can be promoted to the package root only if the dual-use classification is accepted.

## Decision record to complete

Record exactly one outcome before merging the final successor:

- `DUAL_USE`: add `contentPolicy.class = "dual-use"`, add root `DISCLOSURE`, keep first publish interactive + 2FA, and keep future trusted publishing stage-only with human 2FA promotion.
- `NOT_DUAL_USE`: preserve a written rationale referencing the restricted public surface, user authorization model and absence of exploit/malware/security-research purpose; keep the hardened staged workflow anyway.
- `NPM_CONFIRMATION`: retain npm Trust & Safety/support correspondence or ticket reference and implement its classification instructions.

Regardless of classification, FG-013 software licensing remains separate and unresolved. Public release must also replace `UNLICENSED` with the owner-approved software license and ship the corresponding license file.
