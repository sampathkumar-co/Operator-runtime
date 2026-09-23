# Operator Hostile Pre-Submission Probe — 2026-09-18

Purpose: non-mutating hostile/public-edge preflight against the currently deployed OCC-3M production service.

This is **not** the final G36 hostile release simulation because the final successor, real ChatGPT reviewer path, npm publication and submission portal state do not yet exist.

## Probe constraints

- no valid bearer token used;
- no reviewer credential used;
- no state-changing MCP tool invoked;
- no production configuration changed;
- no deployment performed.

## Results

| Probe | Expected | Result |
|---|---|---|
| `GET /` | public site healthy | **200** |
| `GET /privacy` | live privacy page | **200** |
| `GET /terms` | live terms page | **200** |
| `GET /support` | live support page | **200** |
| protected-resource metadata | available | **200** |
| OpenAI challenge before real token | fail closed | **404** |
| unauthenticated `POST /mcp` | auth required | **401** |
| malicious Origin `https://evil.invalid` | rejected | **403** |
| forged Host `evil.invalid` | rejected | **421** |
| non-JSON MCP body | media type rejected | **415** |
| valid JSON body 1,048,585 bytes | request too large | **413 Request Entity Too Large** |

The oversized JSON retry disabled `Expect: 100-continue` so the terminal 413 response could be captured directly.

## Interpretation

The live OCC-3M edge continues to fail closed across unauthenticated access, origin/host confusion and oversized-body input while keeping the public/legal/metadata endpoints available.

No result here changes the release gate counts. Final G36 still requires the frozen final successor plus the real ChatGPT/reviewer/public-package path and final submission-state simulation.
