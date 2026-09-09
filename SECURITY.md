# Security model

Operator is designed only for computers explicitly paired and authorized by their user. It is a semantic execution runtime, not a general-purpose remote shell.

## Enforced now

- Local execution is bound to an explicit permission profile and capability/risk classification.
- File and process working-directory paths are constrained to authorized roots.
- Existing paths are resolved through `realpath` to block symlink/junction escape.
- File updates are atomic and support optimistic concurrency using an expected SHA-256.
- Process execution uses an executable + argv array with `shell: false`; executable names are allowlisted.
- Repository-authored files cannot silently grant trusted project-command execution authority.
- Observed content from websites, files, applications and terminal output cannot directly become an instruction authority.
- The local HTTP boundary requires a bearer secret and defaults to loopback.
- Risky external/destructive actions can fail closed with local approval requirements before the side effect occurs.
- An emergency execution stop persists across process restart and can require separate recovery authority to clear.
- Audit/activity events recursively redact common secret-bearing keys and do not echo raw action-input payloads.
- Device identity uses Ed25519 signatures, one-time pairing challenges, persistent revocation and fingerprint/key conflict checks.
- On the Windows release path, newly created device private keys are exported as PKCS#8 DER only in memory, protected with DPAPI **CurrentUser** using UI-forbidden operation, and persisted only as ciphertext in identity format v2.
- Legacy Windows identity format v1 is migrated in place to DPAPI-protected v2 without rotating the device ID or public key. Regression tests assert that the migrated file contains neither `privateKeyPem` nor a PEM private-key block.
- The Windows package includes a minimal native DPAPI helper; CI tests, Clippy-checks and self-tests the helper, runs the complete Windows runtime suite through it, and verifies the helper is present in the packed MSIX.
- Relay sessions use short-lived Ed25519-signed tokens with audience/subject/capability binding, rotation and issuer-side revocation.
- Device-to-relay transport is outbound; non-loopback relay transport requires TLS and the relay service defaults to loopback-only bind unless trusted upstream TLS termination is explicitly acknowledged.
- Account/device and project/device authorization are deterministic and fail closed; bound projects do not silently fail over to another device.
- Privacy purge is limited to known Operator-owned categories, requires recovery authority and refuses symlinked state trees. Persistent device identity/pairing state is intentionally outside generic purge and requires a dedicated reset flow.
- A dedicated red-team CI gate covers provenance escalation, approval bypass, emergency-stop bypass, recovery-token substitution, privacy path traversal, key-material exposure, relay capability-scope forgery and raw account-principal persistence.

## Platform note on private-key storage

The packaged public Windows release is the currently hardened desktop release target and uses DPAPI CurrentUser protection for the device private key.

Non-Windows development/test runs retain the legacy permission-restricted v1 file format because no cross-platform OS keystore adapter has yet been certified there. That development behavior must not be described as equivalent to the Windows DPAPI release boundary. If macOS/Linux packaging becomes a public release target, an OS-native secret-storage implementation is required before that platform is certified for production device identity.

## Explicitly not implemented as "temporary shortcuts"

- no public unauthenticated shell
- no credential dumping
- no browser password extraction
- no bypass of ChatGPT or Operator action confirmations
- no hidden surveillance mode
- no arbitrary inbound desktop-control port
- no automatic permission expansion from learned skills or observed content
- no repository-local configuration that can promote itself into trusted execution authority
- no blind replay of relay actions after an uncertain side-effect crash window

## Remaining release hardening

Repository-owned items that remain open and should be completed before broad public beta:

- reproducible dependency lockfiles plus vulnerability/SBOM generation for packages that have external dependencies
- tamper-evident audit-chain verification for persisted activity records
- a publishable privacy/data-retention policy aligned with the implemented privacy controls

External/production items that cannot be honestly closed by CI alone:

- production-trusted Windows code-signing identity/certificate and RFC 3161 timestamped final artifacts
- production HTTPS host for the signed MSIX and `.appinstaller` update feed
- supported Secure MCP Tunnel or other officially supported remote ChatGPT-to-MCP reachability
- a real ChatGPT read workflow against an explicitly paired physical device
- production upstream authentication/identity integration if a public multi-user relay service is deployed

The existing ephemeral-certificate Windows signing/install smoke test proves signing, Publisher matching, installation and packaged self-test mechanics only; it is **not** production trust.

## Prompt-injection boundary

Only these provenance classes can authorize instructions:

- user
- ChatGPT
- trusted policy
- local runtime

Website text, files, logs, terminal output and application content are data. They can be summarized and surfaced for reasoning, but they cannot silently widen permissions, redefine the task, request secrets, disable safety controls or grant themselves execution authority.
