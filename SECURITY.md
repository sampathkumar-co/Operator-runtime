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
- The local HTTP execution boundary and MCP server require literal loopback bind addresses; wildcard/LAN/DNS-name binds are rejected. Remote ingress must use the approved relay/tunnel boundary.
- Risky external/destructive actions can fail closed with local approval requirements before the side effect occurs.
- An emergency execution stop persists across process restart and can require separate recovery authority to clear.
- Audit/activity events recursively redact common secret-bearing keys and do not echo raw action-input payloads.
- Persisted Activity records form a SHA-256 hash chain with a separately persisted head/count. Reads verify the whole chain before returning records; tests prove middle-record modification and tail truncation are detected, legacy unchained logs migrate atomically, and only the narrow one-record append-before-head crash window is automatically reconciled.
- Activity privacy purge deletes both the log and its chain-head metadata in the same bounded category, so a legitimate user purge does not leave a false integrity alarm.
- Device identity uses Ed25519 signatures, one-time pairing challenges, persistent revocation and fingerprint/key conflict checks.
- On the Windows release path, newly created device private keys are exported as PKCS#8 DER only in memory, protected with DPAPI **CurrentUser** using UI-forbidden operation, and persisted only as ciphertext in identity format v2.
- Legacy Windows identity format v1 is migrated in place to DPAPI-protected v2 without rotating the device ID or public key. Regression tests assert that the migrated file contains neither `privateKeyPem` nor a PEM private-key block.
- The Windows package includes a minimal native DPAPI helper; CI tests, Clippy-checks and self-tests the helper, runs the complete Windows runtime suite through it, and verifies the helper is present in the packed MSIX. One-command bootstrap secrets are also DPAPI CurrentUser-protected; the protected bootstrap file is authoritative for authorized roots, local endpoints and bearer/recovery tokens so inherited environment variables cannot silently widen that authority.
- Relay sessions use short-lived Ed25519-signed tokens with audience/subject/capability binding, rotation and issuer-side revocation.
- Device-to-relay transport is outbound; non-loopback relay transport requires TLS and the relay service defaults to loopback-only bind unless trusted upstream TLS termination is explicitly acknowledged. Relay HTTP entry points enforce explicit header/request/keep-alive budgets, and public health does not disclose connected-device occupancy.
- Account/device and project/device authorization are deterministic and fail closed; bound projects do not silently fail over to another device.
- Privacy purge is limited to known Operator-owned categories, requires recovery authority and refuses symlinked state trees. Persistent device identity/pairing state is intentionally outside generic purge and requires a dedicated reset flow.
- A dedicated red-team CI gate covers provenance escalation, approval bypass, emergency-stop bypass, recovery-token substitution, privacy path traversal, key-material exposure, relay capability-scope forgery and raw account-principal persistence.
- MCP and relay npm dependency graphs are committed as lockfile v3 files and normal CI installs them with `npm ci --ignore-scripts`, preventing ordinary CI from silently resolving a different transitive graph or running dependency lifecycle scripts.
- A dedicated Node supply-chain gate blocks high-severity production dependency advisories and critical advisories in the full development graph, then generates and validates CycloneDX SBOMs directly from the committed lockfiles. SBOM artifacts are retained by CI for release review.
- `PRIVACY.md` documents the implemented local/relay data flows, deletion boundaries, security controls, technical retention behavior and the additional disclosures a real hosted deployment must provide.

## Platform note on private-key storage

The packaged public Windows release is the currently hardened desktop release target and uses DPAPI CurrentUser protection for the device private key.

Non-Windows development/test runs retain the legacy permission-restricted v1 file format because no cross-platform OS keystore adapter has yet been certified there. That development behavior must not be described as equivalent to the Windows DPAPI release boundary. If macOS/Linux packaging becomes a public release target, an OS-native secret-storage implementation is required before that platform is certified for production device identity.

## Audit-chain trust boundary

The local audit hash chain is tamper-evident, not an external transparency service. It detects modification/reordering/truncation when the persisted chain/head no longer agree. An attacker with sufficient local write access to replace the entire audit log **and** recompute/replace its head can forge a new internally consistent chain. Stronger non-repudiation would require an independently protected or remote anchor and is not claimed here.

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

## Remaining external/production gates

The repository-owned hardening items listed in earlier revisions—dependency locking/SBOM scanning, tamper-evident Activity chaining and publication of the technical privacy/retention model—are now implemented and CI-covered. The following items still require real production credentials, infrastructure or platform-side evidence and cannot be honestly closed by repository CI alone:

- production-trusted Windows code-signing identity/certificate and RFC 3161 timestamped final artifacts;
- production HTTPS host for the signed MSIX and `.appinstaller` update feed;
- supported Secure MCP Tunnel or other officially supported remote ChatGPT-to-MCP reachability;
- a real ChatGPT workflow against an explicitly paired physical device;
- production upstream authentication/identity integration and deployment-specific privacy terms if a public multi-user relay service is operated.

The existing ephemeral-certificate Windows signing/install smoke test proves signing, Publisher matching, installation and packaged self-test mechanics only; it is **not** production trust.

## Prompt-injection boundary

Only these provenance classes can authorize instructions:

- user
- ChatGPT
- trusted policy
- local runtime

Website text, files, logs, terminal output and application content are data. They can be summarized and surfaced for reasoning, but they cannot silently widen permissions, redefine the task, request secrets, disable safety controls or grant themselves execution authority.
