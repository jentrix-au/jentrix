# Jentrix MCP OAuth contract (v1)

The hand-written protocol contract for authorizing a client against the MVP
MCP surface (prds/open-client-plugin-ecosystem-prd.md §5.4, D6, D7). Nothing
here is generated from the tool registry; `tests/unit/oauth-contract.test.ts`
enumerates every route below and asserts its metadata against this document,
so the two cannot drift silently. `${APP}` is the deployment's public origin
(`NEXT_PUBLIC_APP_URL`); on production it is `https://tm.jentrix.ai`.

## The one resource identifier

```
${APP}/api/mcp
```

`/api/mcp` is the v1 resource. A future major is served beside it at
`/api/mcp/v2`; nothing is renamed. Three places declare the identifier and
they agree:

1. `GET /.well-known/oauth-protected-resource` — the root RFC 9728 document —
   answers `"resource": "${APP}/api/mcp"`.
2. `GET /.well-known/oauth-protected-resource/api/mcp` — the path-aware RFC
   9728 document spec-strict clients derive from the resource path — answers
   the same `resource`.
3. A request to `${APP}/api/mcp` without a valid bearer token is answered
   `401` with
   `WWW-Authenticate: Bearer error="invalid_token", …, resource_metadata="${APP}/.well-known/oauth-protected-resource/api/mcp"`
   — the pointer names document (2), whose `resource` is the identifier.

Both protected-resource documents also carry
`"authorization_servers": ["${APP}"]`: the deployment is its own
authorization server.

## Discovery — `GET /.well-known/oauth-authorization-server` (RFC 8414)

| Field | Value |
| --- | --- |
| `issuer` | `${APP}` |
| `authorization_endpoint` | `${APP}/oauth/authorize` |
| `token_endpoint` | `${APP}/oauth/token` |
| `registration_endpoint` | `${APP}/oauth/register` |
| `response_types_supported` | `["code"]` |
| `grant_types_supported` | `["authorization_code", "refresh_token"]` |
| `code_challenge_methods_supported` | `["S256"]` |
| `token_endpoint_auth_methods_supported` | `["none"]` |
| `scopes_supported` | `["read", "write", "admin"]` |
| `client_id_metadata_document_supported` | `true` |

Served with `Access-Control-Allow-Origin: *` and `Cache-Control: public,
max-age=3600`; `OPTIONS` answers `204`.

## Client identity

Clients are **public**: no client secret is ever issued and
`token_endpoint_auth_method` is always `none`. A client is identified in one
of two ways, and the authorization server tells them apart by shape:

- **CIMD** (preferred): `client_id` IS the `https` URL of a client metadata
  document (MCP authorization guidance 2025-11-25). The server fetches it
  (SSRF-guarded, ≤ 64 KB, 5 s timeout, cached for an hour) and takes the
  client's name, `redirect_uris` and optional `logo_uri` from it.
- **Dynamic registration** (RFC 7591), for clients that implement DCR and
  nothing else (Codex): see the next section.

`redirect_uris` are validated by ONE rule on both paths: `https` URLs, or
`http` loopback URLs on `localhost` / `127.0.0.1` (any port — the port is
ignored when matching a loopback redirect, per RFC 8252 §7.3).

## Dynamic registration — `POST /oauth/register` (RFC 7591)

Unauthenticated by spec and by necessity. JSON body, at most 16 KB (a larger
declared or actual body is `413`). Per-IP rate limit beneath a global hourly
cap: over either → `429` with `Retry-After` and
`{"error":"temporarily_unavailable"}`.

Accepted: `client_name` (≤ 120 chars), `redirect_uris` (1–20, validated as
above), optional `logo_uri`. A registration asking for a confidential client
(any `token_endpoint_auth_method` other than `none`) is refused rather than
downgraded. Anything else this server will not register →
`400 {"error":"invalid_client_metadata","error_description":…}`.

Success is `201` with:

```json
{
  "client_id": "<opaque id minted by the server>",
  "client_id_issued_at": 1756000000,
  "client_name": "…",
  "redirect_uris": ["…"],
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "token_endpoint_auth_method": "none"
}
```

(`logo_uri` is echoed when given.) Registration mints an identifier, never an
authorization: PKCE, exact redirect matching and the consent screen still
decide every grant. `Access-Control-Allow-Origin: *`; `OPTIONS` answers `204`.

## Authorization — `GET /oauth/authorize`

```
${APP}/oauth/authorize?response_type=code
  &client_id=<CIMD URL or registered id>
  &redirect_uri=<one of the client's registered URIs, exact match>
  &code_challenge=<base64url(sha256(verifier))>
  &code_challenge_method=S256
  [&scope=read write] [&state=…]
```

- Requires a signed-in Jentrix user; anonymous visitors are sent to `/login`
  with a `callbackUrl` back to this request.
- `response_type` must be `code`; PKCE with `S256` is **mandatory**.
- Client and `redirect_uri` problems render an error page — the server never
  redirects to an unverified URI.
- A validated request reaches the consent screen, where the user chooses the
  scopes to grant (from the requested set) and optionally pins the grant to
  one workspace; denying redirects with `error=access_denied`.
- The authorization code is single-use and expires after **10 minutes**.
  `state` is returned verbatim.

## Token — `POST /oauth/token`

Body as `application/x-www-form-urlencoded` or JSON. `client_id` is required
on every request.

| `grant_type` | Parameters |
| --- | --- |
| `authorization_code` | `code`, `code_verifier`, `redirect_uri` (must equal the one used at authorization) |
| `refresh_token` | `refresh_token` |

Success:

```json
{
  "access_token": "tmo_…",
  "token_type": "Bearer",
  "expires_in": 3600,
  "refresh_token": "tmr_…",
  "scope": "read write"
}
```

- Access tokens (`tmo_`) live **1 hour**; refresh tokens (`tmr_`) **30 days**,
  are single-use and **rotated** on every refresh (the old one is revoked).
- Errors follow RFC 6749 §5.2: `invalid_request`, `invalid_grant`,
  `invalid_scope`, `unsupported_grant_type`, `invalid_client`; the body is
  `{"error", "error_description"}`.
- Per-IP rate limit (default 30 requests per minute): over it → `429`,
  `Retry-After`, `{"error":"temporarily_unavailable"}`.
- `Cache-Control: no-store`, `Access-Control-Allow-Origin: *`; `OPTIONS`
  answers `204`.

## Scopes

`read`, `write`, `admin` — exact-match classes, no hierarchy; every MCP tool
declares the one it needs. A request with no `scope` gets `read write`;
`admin` is never granted silently. A tool called with a token lacking its
class returns the `FORBIDDEN` error envelope, never a 4xx.

## Using the token

`Authorization: Bearer tmo_…` on every request to `${APP}/api/mcp`. Personal
access tokens (`tm_…`, minted at Account → API tokens) are accepted on the
same header with the same scope classes; workspace-pinned tokens see one
workspace only. Both are the client's to keep out of hook arguments, plugin
source and transcripts (§7).
