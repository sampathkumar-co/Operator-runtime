# Operator privacy and data-retention model

Operator is designed for computers explicitly authorized and paired by their user. This document describes the behavior of the open-source/reference runtime in this repository. A hosted Operator service must additionally publish deployment-specific terms, hosting locations, retention periods, subprocessors and contact information before collecting production user data.

## Privacy principles

Operator follows these defaults:

- prefer local execution and local state for computer-control data;
- collect only state required to authorize, route, execute, verify, recover and audit user-requested actions;
- do not turn observed website/file/application content into an instruction authority;
- do not provide credential-dumping, browser-password extraction, hidden-surveillance or background permission-expansion features;
- do not record action input payloads in the local Activity/audit feed;
- expose bounded deletion controls for ordinary history while keeping identity-reset operations separate and explicit.

## Data kept on an Operator device

Depending on enabled features, the local agent may persist:

- **Device identity metadata:** device UUID, display name, creation time and Ed25519 public key/fingerprint.
- **Device private identity key:** on the Windows release path this is stored as a DPAPI CurrentUser-protected PKCS#8 blob. Legacy Windows plaintext identities are migrated in place without rotating the public identity. The current macOS/Linux development path uses permission-restricted local key storage and is not represented as equivalent production hardening.
- **Pairing and routing state:** paired peer public identities, revocation state, opaque project-to-device bindings and session metadata.
- **Task Capsules:** bounded task objectives, scopes, status and verification metadata used for resumable work.
- **Activity/audit metadata:** capability name, result, risk, timestamps and bounded evidence references. Action input payloads are not copied into this feed. Secret-bearing keys in audit details are recursively redacted.
- **Relay recovery state:** delivery sequence/ACK cursors, processing state and locally persisted completed results needed to prevent blind duplicate side effects after a crash.
- **Emergency-stop state:** whether execution is stopped and bounded local reason/timestamp metadata.

Authorized project files remain user files. Operator does not copy an authorized project tree into its own state store merely because the project is authorized.

## Data sent through a relay when relay mode is enabled

The reference relay exists so an authorized ChatGPT/MCP side can reach a paired computer without opening an inbound desktop-control port on that computer. When relay mode is used, the relay may process or persist:

- generated account UUID and a SHA-256 hash of the upstream authentication issuer/subject pair; the reference account registry does not persist the raw issuer or raw subject;
- paired device UUID, public key/fingerprint, account membership and revocation state;
- short-lived session-token identifiers, audience and capability scopes;
- online device presence, opaque project routing keys and delivery/ACK sequence metadata;
- the bounded action envelope that must be delivered to the selected device;
- the structured action result/evidence returned by that device;
- durable queued deliveries and returned results required for reconnect/resume and idempotent result handling.

Opaque project routing keys are not filesystem paths. Individual action payloads can nevertheless contain an authorized local path when that particular capability requires a path to perform the user's request.

Public relay deployments must use TLS. The production relay client accepts non-TLS WebSocket transport only for explicit loopback development.

## What Operator does not intentionally collect

The certified runtime does not contain a hidden telemetry pipeline. It does not intentionally extract or upload browser password stores, saved passwords, authentication cookies, arbitrary credential files or unrelated project data.

Browser and application content can be inspected when necessary to carry out an authorized user task. Such content is treated as observed data, not as a new permission source.

## Retention and deletion

Local Operator state is durable because recovery, replay protection, revocation and auditability depend on persistence. It remains until the relevant state is explicitly cleared or the Operator installation/state directory is reset.

The authenticated local privacy API inventories only known Operator-owned categories and supports recovery-credential-gated deletion of:

- Activity history, including both `audit.ndjson` and its hash-chain head metadata;
- Task history;
- transient session state.

Generic privacy deletion intentionally cannot erase device identity or pairing state. Those records are security identities and require a dedicated device-reset/revocation flow rather than a broad history-delete endpoint. Deletion refuses symbolic-link traversal and does not wildcard-delete arbitrary paths.

The reference relay uses durable account/device, delivery and result stores. A real hosted service must define and enforce concrete server-side retention/deletion periods before public production use; this repository does not claim a universal hosted-retention duration.

## Integrity and security controls

- Local Activity records form a SHA-256 hash chain linked by `previousHash`, with a separately persisted head/count. The runtime detects record modification, reordering and ordinary tail truncation and can recover only the narrow one-record append-before-head crash window.
- The audit head lives on the same local trust boundary as the log. An attacker who can rewrite both files and recompute the entire chain can defeat this local tamper-evidence mechanism; it is not a remote transparency log or hardware-backed signature service.
- Windows persistent device private keys use DPAPI CurrentUser protection in the release path.
- Relay pairing and sessions use Ed25519 signatures, bounded session lifetime, audience/device/scope binding, rotation and revocation.
- Local execution remains subject to local capability/path permissions, risk approval policy and the persistent emergency stop even when an action arrives through the relay.
- Release artifacts are checked against signed release-manifest metadata and SHA-256; public Windows distribution additionally requires a trusted production code-signing identity.

## User controls

Users/deployers control the roots a device can access, executable allowlists, capability permissions, approval policy, paired-device revocation, project routing, privacy deletion and the emergency execution stop. Clearing the emergency stop and destructive privacy deletion can require a separate local recovery credential so the normal agent credential cannot silently erase its own safety/audit boundary.

## Hosted-service responsibilities

Anyone operating a public relay or distributing Operator to other users must supplement this technical model with the actual service's legal/privacy notice, including at minimum:

- operator/controller identity and contact method;
- exact hosting regions and infrastructure providers;
- concrete server-side retention periods and deletion procedure;
- upstream authentication provider and any other subprocessors;
- support/security reporting channel;
- jurisdiction-specific rights and disclosures where applicable.

This repository document describes implemented technical behavior; it is not a substitute for deployment-specific legal advice or a service-specific privacy notice.
