# MCP transport adapter

This directory is intentionally transport-only. The execution kernel lives in `src/core` and the local machine boundary lives in `apps/local-agent`.

The production ChatGPT integration uses the current MCP TypeScript v2 server SDK and Streamable HTTP, then routes authenticated calls to paired devices through the relay/tunnel layer. The runtime is not allowed to become dependent on MCP or one model provider.

`src/tool-surface.ts` is the canonical external tool-name/risk manifest. The protocol E2E suite enumerates the live MCP server and fails if it drifts from that manifest. Do not expose every internal capability as a ChatGPT tool.

Before a real Secure MCP Tunnel / ChatGPT certification run, start the local agent and MCP server and run:

```bash
npm run certify:local
```

The command emits a secret-free JSON preflight receipt containing the exact tool count, deterministic tool-surface SHA-256 fingerprint, and a verified `computer.inspect` read probe. It deliberately marks the Secure MCP Tunnel and real ChatGPT workflow as `NOT_RUN`; only the real supported ChatGPT connection may close those external gates.

For the private/live OpenAI tunnel gate, use the reviewed official Windows amd64 `tunnel-client` v0.0.14 binary. The preflight pins the official archive published SHA-256 plus the executable SHA-256 derived from that verified archive, and refuses unreviewed binaries. Keep the runtime API key only in the process environment; it is referenced as `env:CONTROL_PLANE_API_KEY` and is never placed on the command line or in the receipt.

```powershell
$env:OPERATOR_TUNNEL_CLIENT_PATH = 'C:\path\to\tunnel-client.exe'
$env:OPERATOR_MCP_URL = 'http://127.0.0.1:47200/mcp'
$env:CONTROL_PLANE_TUNNEL_ID = 'tunnel_<32 lowercase hex>'
$env:CONTROL_PLANE_API_KEY = '<runtime key with Tunnels Read + Use>'
npm run certify:tunnel
```

If Platform tunnel credentials are not configured, `certify:tunnel` exits with status 2 and emits a secret-free `BLOCKED` receipt. A `PASS` receipt certifies the reviewed tunnel client and its `doctor` path to the local Operator MCP endpoint; it still does not claim that a real ChatGPT-originated workflow has run.
