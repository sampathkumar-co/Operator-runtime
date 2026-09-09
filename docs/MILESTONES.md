# Milestones

## M0 — execution kernel foundation

Acceptance gates:

- [x] compact action/result protocol
- [x] capability router
- [x] local capability permission checks
- [x] instruction provenance enforcement
- [x] evidence objects
- [x] persistent Task Capsules
- [x] native filesystem with scope enforcement
- [x] argv-only process execution
- [x] Git read adapter
- [x] semantic project inspection
- [x] browser CDP discovery
- [x] local-agent bearer authentication
- [x] redacting audit log
- [x] device identity signing
- [x] security tests
- [x] initial MCP v2 adapter source
- [ ] MCP adapter dependencies installed and end-to-end tested

## M1 — browser kernel + secure ChatGPT dev loop — CURRENT

- [x] persistent CDP target session manager
- [x] connect to existing Chrome/Edge through configured loopback CDP
- [x] internal new-tab creation primitive
- [x] navigation with URL postcondition verification
- [x] compact DOM/accessibility representations
- [x] semantic element locate/click/type/select
- [x] bounded console/runtime-exception/network-failure capture during actions
- [x] credential-bearing and non-HTTP(S) URL rejection
- [ ] internal tab focus/close primitives
- [ ] download initiation and completion events
- [ ] iframe/shadow-DOM strategy
- [ ] browser attach/launch discovery across Chrome + Edge profiles
- [ ] MCP adapter dependencies installed and MCP Inspector test
- [ ] Secure MCP Tunnel test
- [ ] real ChatGPT read workflow test

## M2 — Windows semantic kernel

- Win32 window/process discovery
- UI Automation tree inspection
- Invoke/Value/Selection/ExpandCollapse/Scroll patterns
- focus/window activation
- event subscriptions
- semantic wait-for-control
- fallback routing when UIA coverage fails

## M3 — development adapter suite

- Git write/checkpoint/restore
- VS Code adapter
- Docker adapter
- PostgreSQL structured client
- project command registry
- build/test artifact validators
- checkpoint/rollback engine

## M4 — relay + multi-device

- account/device registry
- signed pairing challenge
- outbound persistent connection
- short-lived session tokens
- rotation/revocation
- device routing
- project-to-device resolution
- reconnect/resume

## M5 — companion UI and publication hardening

- Devices / Tasks / Permissions / Activity / Settings
- emergency disconnect
- installer + auto-update
- code signing
- privacy/data controls
- submission assets
- red-team suite
- performance benchmark suite
- final platform-matrix revalidation
