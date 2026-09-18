# DRAFT — npm Dual-Use DISCLOSURE for @mecrod/operator

**Draft only. Not active package metadata. Do not copy into the published tarball until the owner accepts the dual-use classification.**

Package: `@mecrod/operator`
Intended package-root filename if adopted: `DISCLOSURE`

## Purpose

`@mecrod/operator` is a Windows runtime that lets a user connect a computer they control to Mecord Connect so ChatGPT can perform explicitly authorized developer-project tasks through the hosted Operator MCP service.

The runtime is intended for legitimate local developer automation and remote-assistance workflows on computers the user is authorized to control. It is not intended to provide unauthorized access to third-party systems, bypass security controls, deploy malware, conceal malicious activity, steal credentials, or operate as a covert remote-access tool.

## Dual-use functionality disclosed

The package contains capabilities that can resemble functionality found in security-sensitive or remote-administration software, including:

- authenticated device pairing and remote task relay;
- local filesystem/project inspection and bounded mutation;
- Windows UI Automation support in the private/local runtime;
- managed browser support in the private/local runtime;
- Windows DPAPI-based protection for local device credentials;
- path-authority enforcement helpers and local execution-policy controls.

These capabilities have legitimate uses but may be classified as security-relevant by automated scanners, which is why this disclosure exists if the package is declared dual-use under npm policy.

## Safety and authorization model

The public ChatGPT/MCP surface is intentionally narrower than the private runtime. It does not publish generic terminal execution, browser automation, or raw Windows UI Automation tools. Public project/file/Git operations require OAuth scopes and are routed only to a paired device/account relationship.

The local runtime remains the final execution-policy boundary. It re-checks authorized roots, capability policy, risk classification, emergency-stop state and one-time approvals before execution. Destructive operations such as file replacement require the local approval/precondition model rather than relying only on remote authorization.

Credential-bearing paths and restricted data are filtered from the public plugin surface, and internal relay/provider diagnostics are minimized from public responses.

## Intended legitimate use

Examples of intended use include inspecting an authorized software project, reading safe source files, creating or replacing project files under the local policy boundary, inspecting local Git state, and connecting a user's authorized development computer to their Operator account.

Use against systems, accounts or data without authorization is outside the intended use of this package and may also violate the service Terms, npm policy and applicable law.

## Publication note

If this draft is adopted, publish it as the root file `DISCLOSURE` and add:

```json
"contentPolicy": {
  "class": "dual-use"
}
```

The declaration must then remain present in future package versions unless npm Trust & Safety approves its removal.
