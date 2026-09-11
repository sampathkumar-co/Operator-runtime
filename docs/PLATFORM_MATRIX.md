# ChatGPT platform matrix

Last reviewed: 2026-09-11

This file is deliberately conservative. Re-check official OpenAI documentation before every release because app/plugin capabilities and plan availability are changing.

| Surface / plan | Current design assumption | Release implication |
|---|---|---|
| Plugin Directory | Directory is the primary discovery surface for plugins; a plugin can package apps/skills/templates. Availability of a particular capability still depends on plan, workspace, role, region and surface. | Build the app as a publishable MCP-backed capability, but do not promise universal invocation. |
| Pro | Apps SDK development is available; current official guidance permits custom MCP connections with read/fetch permissions in developer mode, but full MCP write/modify is limited to Business and Enterprise/Edu. | Use Pro only for read/fetch certification; do not claim write/modify certification from Pro. |
| Business | Full MCP including write/modify is in beta on ChatGPT web; admins/owners control developer mode and workspace publication. | Supported near-term certification target for the complete Operator write workflow when the tester has the required admin/owner access. |
| Enterprise/Edu | Full MCP including write/modify is in beta on ChatGPT web with additional RBAC/action controls. | Supported certification target for the complete Operator write workflow and managed deployment. |
| Plus / Free / Go | The current developer-mode/full-MCP guidance does not list these plans as custom MCP developer-mode certification targets. | Do not use these plans to close Operator custom-MCP release gates unless current official documentation explicitly adds the required capability. |
| Mobile | Current custom MCP app developer workflow is web-oriented; official help currently states MCP apps are not available on mobile. | Do not advertise mobile computer control in v1. |
| Agent mode | Official current guidance says Agent mode does not use custom apps. | Normal ChatGPT + app/plugin remains our primary control plane; do not require Agent mode. |
| Deep research | Custom apps may be used for read/fetch, not write actions. | Useful for evidence gathering, not execution. |
| Private/local MCP | ChatGPT does not directly connect to localhost-only MCP servers. Secure MCP Tunnel provides outbound-only private connectivity for supported OpenAI products and developer-mode testing. | Use Tunnel for private/live certification without exposing the local MCP server. Tunnel alone is not a public plugin distribution endpoint. |
| Public plugin MCP | Public plugin submission/distribution requires a stable publicly reachable HTTPS MCP endpoint. A public HTTPS proxy may forward to a private MCP server. | Public release must provision and certify this HTTPS endpoint/proxy separately from Secure MCP Tunnel. |

## Official references to re-check

- https://help.openai.com/en/articles/12584461
- https://help.openai.com/en/articles/12515353-build-with-the-apps-sdk
- https://help.openai.com/en/articles/11487775-apps-in-chatgpt
- https://help.openai.com/en/articles/20001256-plugins-in-chatgpt-and-codex

- https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
