# mecord-connect

One-command Windows runtime for connecting a user-authorized computer to Mecord Connect in ChatGPT.

```powershell
npx mecord-connect@latest remote
```

Requires Windows x64 with a supported Node.js line: 22.14+, 24.x, or 26.x. Git features additionally require Git 2.45 or newer; older or missing Git disables only the Git capabilities while the rest of the Mecord Connect runtime remains available.

The command does **not** install an MSIX and does **not** start a local MCP server. It verifies the package's runtime manifest, starts the existing hardened local policy/runtime agent, and connects that agent to the pinned production relay at `wss://operator.splcart.in/device`. ChatGPT talks to the hosted MCP edge.

On first use, when human authorization is actually required, the runtime prints the short-lived secure Mecord pairing link **and automatically opens it in the default Windows browser**. Confirm the device in your Mecord account; ChatGPT does not receive a public device-claim tool. The resulting relay credential is protected for the current Windows user with DPAPI. Future `mecord-connect remote` runs reuse the protected device identity/session path and normally reconnect without opening the browser; pairing reappears only after credential loss, revocation, account/device trust change, or another enrollment requirement.

By default the current directory is the authorized filesystem/project root. To authorize another folder explicitly:

```powershell
npx mecord-connect@latest remote --root C:\path\to\project
```

Use `--no-browser` to disable automatic launch of Mecord Connect's managed-browser capability. Generic terminal execution remains disabled by default; project commands continue to use the existing policy/approval boundary.

When ChatGPT requests an action that requires local approval, Mecord opens a **local Windows approval card** showing the action, risk and target with **Deny**, **Approve Once**, and **Allow Session**. `Allow Session` is memory-only, bound to the same account/device authority generation plus the current authorized roots/capability scope, expires after 8 hours or 60 minutes idle, and disappears when the runtime exits. It suppresses repeated external/system/destructive prompts inside that scope but never bypasses root scoping, capability allowlists, emergency stop, path safety, restricted-data filtering, or provider-specific allowlists. ChatGPT never receives the recovery authority and cannot approve its own request. The terminal remains a fallback with `approve`, `session`, `deny`, `session-status`, and `revoke-session`.

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
