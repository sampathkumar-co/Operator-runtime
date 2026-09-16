# @mecrod/operator

One-command Windows runtime for connecting a user-authorized computer to Operator in ChatGPT.

```powershell
npx @mecrod/operator@latest remote
```

The command does **not** install an MSIX and does **not** start a local MCP server. It verifies the package's runtime manifest, starts the existing hardened local policy/runtime agent, and connects that agent to the pinned production relay at `wss://operator.splcart.in/device`. ChatGPT talks to the hosted MCP edge.

On first use the runtime prints a one-time device pairing code. Claim that code from Operator in the authenticated ChatGPT connection. The resulting short-lived relay credential is protected for the current Windows user with DPAPI and is rotated by the existing relay-session authority.

By default the current directory is the authorized filesystem/project root. To authorize another folder explicitly:

```powershell
npx @mecrod/operator@latest remote --root C:\path\to\project
```

Use `--no-browser` to disable automatic launch of Operator's managed-browser capability. Generic terminal execution remains disabled by default; project commands continue to use the existing policy/approval boundary.

Before starting a session you can verify the package payload and all three Windows-native security helpers:

```powershell
npx @mecrod/operator@latest doctor
```

`doctor` verifies every packaged runtime file against SHA-256/size metadata, exercises the DPAPI and Windows path-lease self-tests, and performs a protocol health check against the UI Automation sidecar. It does not start the relay connection.

## Security model

The npm launcher deliberately rebuilds the child environment from a small desktop allowlist. npm/GitHub/cloud tokens, `.npmrc` pointers, `NODE_OPTIONS`, caller-supplied Operator relay variables, and other ambient credentials are not inherited by the long-running runtime. The public package pins its relay/result authority to `operator.splcart.in`; callers cannot redirect a paired device by setting environment variables.

The runtime payload is produced from the canonical repository sources at publication time, and includes the native DPAPI, UI Automation, and Windows path-lease helpers compiled in the Windows release workflow. The payload manifest records the exact Git commit and hashes every shipped file.
