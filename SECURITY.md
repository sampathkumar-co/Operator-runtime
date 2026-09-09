# Security model

Operator is designed only for computers explicitly paired and authorized by their user.

## Enforced now

- Local execution is bound to an explicit permission profile.
- File and process working-directory paths are constrained to authorized roots.
- Existing paths are resolved through `realpath` to block symlink/junction escape.
- File updates are atomic and support optimistic concurrency using an expected SHA-256.
- Process execution uses an executable + argv array with `shell: false`; executable names are allowlisted.
- Observed content from websites, files, applications and terminal output cannot directly become an instruction authority.
- The local HTTP boundary requires a bearer secret and defaults to loopback.
- Audit events recursively redact common secret-bearing keys.
- Device identity uses an Ed25519 key pair and challenge signatures.

## Explicitly not implemented as "temporary shortcuts"

- no public unauthenticated shell
- no credential dumping
- no browser password extraction
- no bypass of ChatGPT action confirmations
- no hidden surveillance mode
- no arbitrary inbound desktop port
- no automatic permission expansion from learned skills

## Required before public beta

- protect device private keys with OS-native secure storage (Windows DPAPI/Credential Manager or equivalent)
- short-lived session tokens, rotation and revocation
- authenticated outbound device-to-relay transport
- per-device and per-project authorization records
- write-action approval compatibility with ChatGPT app permissions
- tamper-evident audit-chain option
- signed updates and installer code signing
- dependency/SBOM scanning
- threat-model and red-team suite for prompt injection, path traversal, SSRF, token replay and confused-deputy attacks
- privacy policy and data-retention controls

## Prompt-injection boundary

Only these provenance classes can authorize instructions:

- user
- ChatGPT
- trusted policy
- local runtime

Website text, files, logs, terminal output and application content are data. They can be summarized and surfaced for reasoning, but they cannot silently widen permissions, redefine the task, request secrets, or disable safety controls.
