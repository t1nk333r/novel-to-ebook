# Plan 005: Enforce an SSRF-safe outbound URL policy

> **Executor instructions**: Centralize the rule, validate redirects and browser
> navigation, and update `plans/README.md`.
>
> **Drift check**: `git diff --stat 5b03d47..HEAD -- src/index.ts src/lib/browser.ts src/app/projects src/app/utility tests`

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: `plans/002-verification-baseline.md`
- **Category**: security
- **Planned at**: commit `5b03d47`, 2026-08-30

## Why this matters

Request- and project-derived URLs flow into Hono proxying, Puppeteer, font fetches,
and cover downloads. All outbound paths need one explicit policy that permits
ordinary public HTTP(S) sites while rejecting local, private, link-local, and
special-use destinations, including after redirects.

## Current state

- `src/index.ts:47-50` proxies a path-derived target directly.
- `src/app/projects/routes.ts:338` and `utils.ts:532` call `page.goto()`.
- `src/app/utility/utils.ts:16` and `src/app/projects/utils.ts:224` call `fetch()`.
- Only syntactic URL validation exists; no address or redirect policy exists.

## Commands you will need

`pnpm test -- network-policy` and `pnpm check` must exit 0.

## Scope

**In scope**: a shared network-policy module; proxy, browser, font, cover, and
embedded navigation boundaries; deterministic DNS/fetch tests.

**Out of scope**: arbitrary operator allowlists in the UI, VPN discovery, proxy
credential management.

## Steps

1. Add table-driven tests for permitted public HTTP(S), rejected protocols,
   localhost names, IPv4/IPv6 private/special ranges, mixed DNS answers, encoded
   hosts, and redirects to rejected destinations.
2. Implement async URL validation using URL parsing, DNS resolution, and IP-range
   classification. Validate every resolved address; fail closed on resolution
   errors. Provide a manual-redirect bounded fetch wrapper.
3. Apply the policy to proxy, fonts, covers, extraction/import/snapshot browser
   navigation, and browser subrequest/redirect interception without breaking the
   ad blocker's interception coordination.
4. Return a stable 400 error code without exposing internal DNS details.
   **Verify**: `pnpm check` passes.

## Done criteria

- [ ] Every outbound sink imports the shared policy or safe wrapper.
- [ ] Redirects are revalidated.
- [ ] Local/private/special targets are rejected in tests.
- [ ] Public HTTP(S) extraction still passes a mocked integration test.

## STOP conditions

Stop if Puppeteer interception conflicts with the current ad blocker and cannot
be coordinated safely; report the exact interceptor behavior before disabling
either boundary.

## Maintenance notes

DNS answers can change; validation must occur immediately before each connection,
not only when project data is saved.
