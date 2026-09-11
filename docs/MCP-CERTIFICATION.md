# MCP transport certification

## Target

Operator targets the Model Context Protocol TypeScript SDK v2 / 2026-07-28 protocol generation.
The transport adapter intentionally contains no machine-execution policy; it only translates a compact ChatGPT-facing tool surface into authenticated local-agent actions.

## Required release gates

1. Install `apps/mcp-server` dependencies from the public npm registry.
2. Run `npm run check` in `apps/mcp-server` with Node 22.
3. Start the authenticated local agent with a dedicated test root.
4. Start the MCP server against that agent.
5. Connect the official MCP Inspector/client with modern/auto version negotiation.
6. Confirm all advertised tools have the expected annotations and bounded schemas.
7. Execute read-only tools and verify structured evidence reaches the client intact.
8. Verify `browser.interact` and other externally mutating actions remain policy/approval gated locally.
9. Run `npm run certify:local` and retain the secret-free tool-count/fingerprint/read-probe receipt.
10. With the reviewed official tunnel-client binary, export the real Platform tunnel ID and runtime key only into the local process environment, run `npm run certify:tunnel`, and retain the secret-free PASS receipt.
11. While that tunnel runtime is live, connect it from an eligible ChatGPT developer-mode workspace and confirm the connected tool names match the local receipt.
12. Run a real ChatGPT read workflow against a paired test device.

A source-level implementation is **not** considered transport-certified until these gates pass.
