# Plan 004: Default to loopback and authenticate remote API access

> **Executor instructions**: Preserve zero-configuration local use, test ordinary
> and streaming routes, and update `plans/README.md`.
>
> **Drift check**: `git diff --stat 5b03d47..HEAD -- src/index.ts src/app ui/src README.md tests`

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: `plans/002-verification-baseline.md`
- **Category**: security
- **Planned at**: commit `5b03d47`, 2026-08-30

## Why this matters

The API defaults to `0.0.0.0` with no identity boundary. Local use should remain
frictionless, but remote listening must be explicit and authenticated so network
peers cannot mutate projects or consume browser/AI resources.

## Current state

- `src/index.ts:41-44` mounts every API route without middleware.
- `src/index.ts:85-90` hardcodes `hostname: "0.0.0.0"`.
- UI fetch and SSE clients live in `ui/src/lib/api.ts` and `ui/src/lib/sse.ts`.
- No cookie or token mechanism exists.

## Commands you will need

`pnpm test -- auth`, `pnpm typecheck`, and `pnpm check` must exit 0.

## Scope

**In scope**: host configuration, optional bearer-token middleware, UI request
transport, environment documentation, API/SSE/download tests.

**Out of scope**: user accounts, OAuth, roles, multi-tenancy, session storage.

## Steps

1. Add tests proving default host is loopback, local mode needs no token, and a
   non-loopback host fails startup unless an API token is configured.
2. Add constant-time bearer validation for `/api/*` when remote mode is enabled.
   Static assets remain public; ordinary API, SSE, and file downloads share the
   same transport credential policy.
3. Teach UI fetch/SSE/download clients to attach the configured session token
   without persisting it into logs, IndexedDB, or generated schemas.
4. Document `HOST` and `API_TOKEN` names with non-secret examples.
   **Verify**: `pnpm check` exits 0.

## Done criteria

- [ ] Default listener is loopback.
- [ ] Remote startup without a token fails before serving.
- [ ] Wrong/missing remote token returns 401 for API and SSE.
- [ ] No token value is logged or committed.
- [ ] `pnpm check` passes.

## STOP conditions

Stop if the intended deployment relies on anonymous LAN access; that is a product
security decision requiring explicit operator approval.

## Maintenance notes

Reverse-proxy deployments should terminate TLS externally and forward the same
Authorization header; do not introduce browser cookies without a CSRF design.
