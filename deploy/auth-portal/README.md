# Operator account signup portal

This service provides the browser signup surface used in production at `/signup`.
It is intentionally separate from Authelia and writes only to Authelia's file user
database through a shared writable users directory.

## Required deployment contract

- `PORTAL_INVITE_SHA256`: SHA-256 of the out-of-band registration code. Never
  store the plaintext registration code on the server after handoff.
- `PORTAL_USERS_FILE`: shared Authelia user database path.
- `PORTAL_DEFAULT_GROUP`: normal signup group; production uses
  `operator-users`.
- Reverse proxy only `/signup` and `/signup/*` to this service. All other
  auth routes remain owned by Authelia.
- Authelia must mount the same user database read-only and enable its file
  watcher so atomic portal updates reload without restarts.

Passwords are hashed in-process with Argon2id using the production Authelia
parameters: 64 MiB memory, 3 iterations, parallelism 4, 32-byte output.
Passwords are never written to logs, YAML, environment variables, or process
arguments.

## Account and device model

Authentication creates/resolves one Operator account from the upstream
issuer+subject principal. Device enrollment is independent of signup: each
computer has its own Ed25519 device identity and may be bound to the same
account after that account authenticates.

The runtime currently permits up to 32 active devices per account and retains
up to 128 historical device identities per account. A device cannot be active
under two accounts at the same time.
