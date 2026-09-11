# Public MCP Edge Deployment

Operator can expose its MCP adapter as a remote HTTPS resource server without exposing a paired user's local agent. Public mode is opt-in and routes every tool call through the relay authority.

## Security boundary

The supported production path is:

`ChatGPT -> HTTPS/TLS proxy -> Operator MCP edge -> loopback relay control -> relay -> paired device`

The local agent, relay-control service, and device credentials must never be directly internet-facing. A caller cannot choose an Operator account ID: the edge verifies the OAuth access token, extracts a verified `(issuer, subject)` principal, and the relay authority resolves that principal through `AccountDeviceRegistry`.

Public mode fails closed unless all of these are true:

- `OPERATOR_EXECUTION_MODE=relay`
- `OPERATOR_MCP_PUBLIC_EDGE=1`
- `OPERATOR_MCP_PUBLIC_BIND_ACK=TLS_TERMINATES_UPSTREAM`
- the public resource URL is a credential-free standard-port HTTPS URL ending exactly in `/mcp`
- public MCP and OAuth URLs use public DNS hostnames, not loopback, IP literals, or reserved/private namespaces
- OAuth authorization, token and introspection endpoints are configured
- the relay-control token is at least 32 characters and relay control remains loopback-only
- the public bind host is an explicit literal wildcard or loopback address

## Required environment

Use deployment secrets rather than committing values:

```text
OPERATOR_EXECUTION_MODE=relay
OPERATOR_RELAY_CONTROL_URL=http://127.0.0.1:8790
OPERATOR_RELAY_CONTROL_TOKEN=<secret, 32+ characters>
OPERATOR_MCP_PUBLIC_EDGE=1
OPERATOR_MCP_PUBLIC_BIND_ACK=TLS_TERMINATES_UPSTREAM
OPERATOR_MCP_HOST=127.0.0.1
OPERATOR_MCP_PORT=47200
OPERATOR_MCP_PUBLIC_URL=https://mcp.your-domain.tld/mcp
OPERATOR_OAUTH_ISSUER=https://auth.your-domain.tld
OPERATOR_OAUTH_AUTHORIZATION_URL=https://auth.your-domain.tld/authorize
OPERATOR_OAUTH_TOKEN_URL=https://auth.your-domain.tld/token
OPERATOR_OAUTH_INTROSPECTION_URL=https://auth.your-domain.tld/introspect
OPERATOR_OAUTH_AUDIENCE=operator-runtime
OPERATOR_OAUTH_REQUIRED_SCOPE=operator:mcp
OPERATOR_OAUTH_INTROSPECTION_CLIENT_ID=<confidential-client-id>
OPERATOR_OAUTH_INTROSPECTION_CLIENT_SECRET=<secret>
```

Binding the MCP process to `127.0.0.1` behind a same-host reverse proxy is preferred. Wildcard bind is available only for an explicitly isolated container/network topology and still requires the public-edge acknowledgement.

## TLS reverse proxy

Expose only HTTPS. The backend MCP port should stay private. An nginx-style configuration is:

```nginx
server {
    listen 443 ssl http2;
    server_name mcp.your-domain.tld;

    location = /mcp {
        proxy_pass http://127.0.0.1:47200;
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
    }

    location ^~ /.well-known/ {
        proxy_pass http://127.0.0.1:47200;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
    }
}
```

Certificate/key directives depend on the TLS provider. Do not add a proxy rule for relay control. Do not expose port `8790` through a firewall, container publish rule, load balancer, or reverse proxy.

## Startup order

1. Start the relay delivery/result services and confirm paired-device routing independently.
2. Start the loopback relay-control service with `OPERATOR_RELAY_CONTROL_TOKEN`.
3. Start the MCP edge with the public-edge environment above.
4. Start the TLS reverse proxy only after the MCP process has passed its local health check.
5. Register the HTTPS `/mcp` resource with the supported ChatGPT/plugin workflow.

Never replace OAuth identity with a caller-provided `accountId`. The legacy `OPERATOR_RELAY_ACCOUNT_ID` route is retained only for private/single-account relay deployments; public-edge requests use the verified principal path.

## Certification checks

Before public registration, verify:

- `GET /.well-known/oauth-protected-resource/mcp` returns the canonical HTTPS MCP resource and authorization server
- `GET /.well-known/oauth-authorization-server` returns the configured OAuth server metadata
- unauthenticated `/mcp` receives `401` with a bearer challenge pointing at protected-resource metadata
- wrong `Host` and browser `Origin` values are rejected
- inactive, expired, wrong-audience, wrong-issuer and insufficient-scope tokens are rejected
- two distinct upstream subjects resolve to distinct Operator accounts
- relay control is unreachable from outside the host
- no raw OAuth bearer token, OAuth subject, issuer, introspection secret or relay-control secret is logged or persisted as plaintext by Operator
