# MCP transport adapter

This directory is intentionally transport-only. The execution kernel lives in `src/core` and the local machine boundary lives in `apps/local-agent`.

The production ChatGPT integration uses the current MCP TypeScript v2 server SDK and Streamable HTTP, then routes authenticated calls to paired devices through the relay/tunnel layer. The runtime is not allowed to become dependent on MCP or one model provider.

`src/tool-surface.ts` is the canonical external tool-name/risk manifest. The protocol E2E suite enumerates the live MCP server and fails if it drifts from that manifest. Do not expose every internal capability as a ChatGPT tool.

Before a real Secure MCP Tunnel / ChatGPT certification run, start the local agent and MCP server and run:

```bash
npm run certify:local
```

The command emits a secret-free JSON preflight receipt containing the exact tool count, deterministic tool-surface SHA-256 fingerprint, and a verified `computer.inspect` read probe. It deliberately marks the Secure MCP Tunnel and real ChatGPT workflow as `NOT_RUN`; only the real supported ChatGPT connection may close those external gates.
