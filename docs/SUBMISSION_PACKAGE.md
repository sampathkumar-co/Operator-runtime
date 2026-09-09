# Operator Submission Package

This document is the source of truth for publication copy, reviewer notes, demo sequencing and screenshot capture. It intentionally distinguishes claims already backed by repository/CI evidence from claims that must wait for a live public ChatGPT-to-device validation.

## Product name

**Operator**

## One-line description

A policy-gated semantic runtime that lets ChatGPT operate computers explicitly authorized by the user through structured browser, development, system and multi-device capabilities.

## Short description

Operator connects normal ChatGPT workflows to user-authorized computers through a compact semantic tool surface. It prefers native APIs, structured application interfaces, browser DOM/CDP and Windows UI Automation over pixel automation, and requires local policy, evidence and postcondition checks around execution.

## Longer reviewer description

Operator is designed as a controlled execution substrate rather than a generic remote shell. ChatGPT calls semantic MCP tools; the MCP server routes those requests either to an authenticated local agent or through the account/device relay to a paired machine. The paired machine remains the local enforcement boundary.

Capabilities include browser inspection and semantic interaction, scoped filesystem operations, Git checkpoint/write/rollback workflows, trusted project commands with artifact validation, Docker lifecycle management for already-created local Compose services, read-only structured PostgreSQL inspection, VS Code inspection/open operations, and Windows semantic automation through a native UI Automation sidecar.

Every capability carries an explicit risk classification. Local policy can refuse actions before execution, including approval-required external/destructive actions. Operator also provides an emergency execution stop, redacting audit/activity records, persistent task state, device pairing/revocation, deterministic multi-device routing, privacy controls and bounded recovery semantics.

## Reviewer trust model

### ChatGPT is not the local security authority

The MCP layer translates semantic tool calls into Operator action requests. Authorization is enforced again at the local machine boundary. A transport request cannot silently grant itself a stronger permission or risk class.

### Observed content is not instruction authority

Content read from webpages, files or applications is treated as observation, not as an instruction source. The provenance boundary prevents observed content from promoting itself into execution authority.

### No unrestricted shell MCP tool

The public MCP surface is semantic and bounded. Trusted project commands come from an Operator-owned registry stored outside authorized project roots. Repository-authored command configuration cannot grant itself execution authority.

### Risky actions fail closed

External/destructive actions require the corresponding local approval authority. Tests verify that denied actions return structured policy failures such as `APPROVAL_REQUIRED` before the underlying side effect occurs.

## Permission summary

Operator should request only the permissions required for the configured use case:

- explicitly authorized filesystem/project roots
- selected semantic capability families
- local browser connection/isolated managed browser profile where applicable
- local Docker daemon access only when the Docker adapter is enabled
- explicit trusted PostgreSQL profiles for read-only database inspection
- Windows UI Automation only on Windows when computer semantic control is enabled
- paired relay/device identity only when multi-device operation is enabled

Permission expansion must be deliberate. Project files, webpage text or remote delivery payloads cannot silently expand the local policy envelope.

## Privacy summary

Operator stores operational state required for execution and recovery, including task capsules, redacted activity/audit metadata, device identity/pairing state and bounded relay delivery state. Raw upstream account issuer/subject identifiers are not persisted by the account registry; an opaque generated account identifier and a SHA-256 principal hash are used instead.

The generic privacy purge surface covers Operator-owned activity, task-history and transient-session categories. It requires recovery authority and refuses symlinked state trees. Persistent device identity/pairing state is intentionally excluded from generic purge and requires a dedicated reset path.

Device private key material is never returned through the companion read APIs.

## Current certification evidence

The following claims are backed by automated repository gates:

- root runtime/import suite: 102 tests
- root runtime suite green on Ubuntu, Windows and macOS with the same pinned Node release
- official MCP client end-to-end test
- MCP Inspector tool enumeration
- unchanged 22-tool MCP surface in local and relay execution modes
- real WebSocket paired-device relay round trip
- reconnect/ACK continuation and capability denial
- Windows UIA native compile/test/Clippy gate
- security red-team regression gate
- bounded performance-regression gate
- real unsigned MSIX build with Windows SDK MakeAppx
- MSIX unpack/payload/hash/App Installer validation
- ephemeral-certificate SignTool SHA-256 signing and verification
- signed MSIX installation, packaged launcher self-test and uninstall on Windows CI

## Claims that must NOT be made yet

Do not publish the following claims until their external gates are completed:

- "production-signed Windows release" — requires the final trusted signing identity/certificate and production timestamp
- "one-click public auto-update is live" — requires the final HTTPS update host and production-signed artifacts
- "ChatGPT public deployment certified end to end" — requires the supported external MCP reachability/tunnel and an actual ChatGPT invocation
- "marketplace/store approved" — requires the platform's real review process
- "zero risk" or "cannot fail" — Operator is designed to reduce and bound execution risk, not eliminate it

## Recommended demo flow

Use a dedicated demo Windows machine/profile and a non-sensitive sample project.

1. **Pair the device**
   - show the device in the companion Devices surface
   - show that the device is online and capability-scoped
   - do not expose private keys, service credentials or raw tokens

2. **Read-only computer inspection**
   - ask ChatGPT to inspect the computer/application state
   - show structured semantic evidence rather than a raw pixel-only workflow

3. **Browser semantic action**
   - inspect an isolated demo browser tab
   - navigate or interact with a harmless local/test page
   - show postcondition evidence

4. **Development workflow**
   - inspect a sample project
   - create a Git checkpoint
   - make a bounded file/code change through the permitted workflow
   - run a trusted project verification command
   - show artifact/postcondition evidence

5. **Policy denial**
   - request an action intentionally classified external/destructive without approval
   - show the structured `APPROVAL_REQUIRED` denial and confirm the side effect did not occur

6. **Rollback/recovery**
   - run the prepared false-green demo where a command exits zero but required artifact validation fails
   - show that Operator restores the Git checkpoint

7. **Multi-device routing**
   - if two authorized devices are available, bind the demo project to one device
   - show deterministic routing to that device rather than silent failover

8. **Emergency stop**
   - engage the execution stop
   - show a capability being refused
   - clear it using the separate recovery authority

## Demo success criteria

A release demo is accepted only if:

- the public ChatGPT session reaches Operator through the supported production transport
- the paired device is the machine that actually executes the request
- a read action succeeds and returns structured evidence
- at least one risky action is locally denied before side effect when approval is absent
- one verified mutation succeeds with postcondition evidence
- one rollback/recovery path is demonstrated
- no secrets/private keys appear in the recording, screenshots, logs or companion surfaces

## Screenshot capture list

Actual screenshots should be captured from the real release build; do not use fabricated UI screenshots for submission evidence.

Recommended captures:

1. **Devices** — paired device, online status, bounded capabilities
2. **Tasks** — recent task capsule with status/evidence summary
3. **Permissions** — readable capability/risk configuration without secrets
4. **Activity** — redacted bounded execution history
5. **Emergency stop** — clear engaged/disengaged state
6. **ChatGPT semantic inspection result** — structured result from the real external integration
7. **Policy denial** — `APPROVAL_REQUIRED` or equivalent structured refusal
8. **Verified development action** — successful command/artifact evidence
9. **Rollback evidence** — failed verification followed by restored state
10. **Windows installed package** — installed Operator identity/version from the production-signed build

## Suggested screenshot captions

- **Operate the machine you explicitly paired.** Operator routes semantic actions to authorized devices while the local agent remains the enforcement boundary.
- **Semantic before pixels.** Browser DOM/CDP, application adapters and Windows UI Automation are preferred over brittle coordinate automation.
- **Verification is part of execution.** Successful operations return bounded postcondition evidence rather than relying only on process exit codes.
- **Risky actions can stop locally.** Policy enforcement can deny external or destructive requests before the side effect occurs.
- **Recovery is built in.** Git-scoped transactions can checkpoint and restore project state when verification fails.

## Store / marketplace feature bullets

- 22 semantic MCP tools with local and multi-device relay execution
- Browser DOM/CDP inspection and verified interaction
- Windows semantic automation through native UI Automation
- Scoped filesystem, Git, VS Code, Docker and PostgreSQL adapters
- Local risk/approval enforcement and instruction-provenance defense
- Verified project commands and artifact postconditions
- Git checkpoints and rollback for reversible development workflows
- Pairing, revocation and deterministic multi-device routing
- Emergency stop, privacy controls and redacted activity history
- Self-contained Windows MSIX packaging and auto-update metadata

## Support / troubleshooting information for reviewers

For review builds, provide separately through the platform's secure reviewer mechanism:

- review account or pairing procedure, if required
- exact demo device name/project key
- public MCP endpoint or supported tunnel instructions
- known capability restrictions
- recovery/emergency-stop procedure

Never place signing private keys, relay service credentials, local-agent bearer tokens, database passwords or private device material in this document, repository issues, screenshots or reviewer-visible logs.

## Release-owner checklist

Before final submission confirm:

- production signing certificate is valid and not near expiry
- manifest Publisher exactly matches signer subject
- production release is RFC 3161 timestamped
- final `.appinstaller` and MSIX URLs use the intended HTTPS host
- signed artifact SHA-256 matches published metadata
- installed production build passes `Operator.exe --self-test`
- supported public ChatGPT/MCP transport has passed the live read workflow
- policy-denial and recovery demos have been re-run on the release build
- screenshots contain no secrets, usernames/paths that should remain private, tokens or private account data
- all public claims match completed gates in `docs/MILESTONES.md`
