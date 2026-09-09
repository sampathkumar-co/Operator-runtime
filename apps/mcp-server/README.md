# MCP transport adapter

This directory is intentionally transport-only. The execution kernel lives in `src/core` and the local machine boundary lives in `apps/local-agent`.

The production ChatGPT integration will use the current MCP TypeScript v2 server SDK and Streamable HTTP, then route authenticated calls to paired devices through the relay/tunnel layer. The runtime is not allowed to become dependent on MCP or one model provider.

`tool-surface.ts` is the initial compact external surface. Do not expose every internal capability as a ChatGPT tool.
