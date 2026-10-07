# @mecord/capability-sdk

Standalone R6 SDK for third-party Mecord capability extensions.

New capabilities are namespaced as `ext.<extension-id>.<capability>`. Mutable capabilities declare a fixed risk and provider reconciliation. A manifest never grants authority: the runtime still enforces permission, approval, authority, lease, reconciliation, and verification gates.
