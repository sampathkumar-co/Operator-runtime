# ChatGPT platform matrix

Last reviewed: 2026-09-09

This file is deliberately conservative. Re-check official OpenAI documentation before every release because app/plugin capabilities and plan availability are changing.

| Surface / plan | Current design assumption | Release implication |
|---|---|---|
| Plugin Directory | Directory is the primary discovery surface for plugins; a plugin can package apps/skills/templates. Availability of a particular capability still depends on plan, workspace, role, region and surface. | Build the app as a publishable MCP-backed capability, but do not promise universal invocation. |
| Pro | Apps SDK development is available; official current guidance says full MCP write/modify is not generally available like Business/Enterprise/Edu, while read/fetch custom MCP access is supported in developer mode. | Pro is suitable for read-first development/testing; do not base the first public write-capability promise on Pro. |
| Business | Full MCP including write/modify is in beta; admins/owners control developer mode and publication. | Primary near-term workspace target for write workflows. |
| Enterprise/Edu | Full MCP including write/modify is in beta with additional RBAC/action controls. | Strong target for managed deployment and fine-grained permissions. |
| Free / Go | Plugin directory visibility exists broadly, but exact custom-app/action support can vary by rollout/surface. | Treat as unverified for our write workflow until official release documentation confirms exact support. |
| Mobile | Current custom MCP app developer workflow is web-oriented; official help currently states MCP apps are not available on mobile. | Do not advertise mobile computer control in v1. |
| Agent mode | Official current guidance says Agent mode does not use custom apps. | Normal ChatGPT + app/plugin remains our primary control plane; do not require Agent mode. |
| Deep research | Custom apps may be used for read/fetch, not write actions. | Useful for evidence gathering, not execution. |
| Local MCP | ChatGPT does not directly connect to localhost-only MCP servers; official guidance points to Secure MCP Tunnel for private/on-prem/dev-machine servers. | Dev flow uses supported secure tunneling; production may add our relay. |

## Official references to re-check

- https://help.openai.com/en/articles/12584461
- https://help.openai.com/en/articles/12515353-build-with-the-apps-sdk
- https://help.openai.com/en/articles/11487775-apps-in-chatgpt
- https://help.openai.com/en/articles/20001256-plugins-in-chatgpt-and-codex
