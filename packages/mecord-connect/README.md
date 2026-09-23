# mecord-connect

One-command Windows runtime for connecting a user-authorized computer to Mecord Connect in ChatGPT.

```powershell
npx mecord-connect@latest remote
```

Requires Windows x64 with a supported Node.js line: 22.14+, 24.x, or 26.x. Git features additionally require Git 2.45 or newer; older or missing Git disables only the Git capabilities while the rest of the Mecord Connect runtime remains available.

The command does **not** install an MSIX and does **not** start a local MCP server. It verifies the package's runtime manifest, starts the existing hardened local policy/runtime agent, and connects that agent to the pinned production relay at `wss://operator.splcart.in/device`. ChatGPT talks to the hosted MCP edge.

On first use the runtime prints the secure Mecord pairing link and opens the authenticated web pairing flow when possible. Confirm the device in your Mecord account; ChatGPT does not receive a public device-claim tool. The resulting short-lived relay credential is protected for the current Windows user with DPAPI and is rotated by the existing relay-session authority.

By default the current directory is the authorized filesystem/project root. To authorize another folder explicitly:

```powershell
npx mecord-connect@latest remote --root C:\path\to\project
```

Use `--no-browser` to disable automatic launch of Mecord Connect's managed-browser capability. Generic terminal execution remains disabled by default; project commands continue to use the existing policy/approval boundary.

When ChatGPT requests an exact destructive action such as `file.replace`, it can return `APPROVAL_REQUIRED`. Keep the `mecord-connect remote` terminal open: it lists the pending local action and accepts `approve` or `deny` (or an ID prefix if several actions are pending). Approval is local-only, exact-action-bound, one-time, and expires after 10 minutes. ChatGPT never receives the recovery authority and cannot approve its own request. After approving, retry the same ChatGPT action.

Before starting a session you can verify the package payload and all three Windows-native security helpers:

```powershell
npx mecord-connect@latest doctor
```

`doctor` verifies every packaged runtime file against SHA-256/size metadata, exercises the DPAPI and Windows path-lease self-tests, and performs a protocol health check against the UI Automation sidecar. It does not start the relay connection.

## Security model

The npm launcher deliberately rebuilds the child environment from a small desktop allowlist. npm/GitHub/cloud tokens, `.npmrc` pointers, `NODE_OPTIONS`, caller-supplied Mecord Connect relay variables, and other ambient credentials are not inherited by the long-running runtime. The public package pins its relay/result authority to `operator.splcart.in`; callers cannot redirect a paired device by setting environment variables.

The runtime payload is produced from the canonical repository sources at publication time, and includes the native DPAPI, UI Automation, and Windows path-lease helpers compiled in the Windows release workflow. The payload manifest records the exact Git commit and hashes every shipped file.

## Support and policies

- Support: https://operator.splcart.in/support
- Privacy: https://operator.splcart.in/privacy
- Terms: https://operator.splcart.in/terms
- License: proprietary Mecord Connect Runtime License in `LICENSE`
- Dual-use disclosure: `DISCLOSURE`
- Issues: https://github.com/sampathkumar-co/Operator-runtime/issues
