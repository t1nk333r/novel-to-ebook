# Plan 018: Add a production build and executable documentation

> **Executor instructions**: Validate every documented command from a clean
> checkout shape and update `plans/README.md`.
>
> **Drift check**: `git diff --stat 5b03d47..HEAD -- README.md ui/README.md package.json .env.example .gitmodules src/index.ts`

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: `plans/001-standardize-workspace.md`, `plans/002-verification-baseline.md`, `plans/004-protect-remote-api.md`
- **Category**: docs
- **Planned at**: commit `5b03d47`, 2026-08-30

## Why this matters

Root production start serves `ui/dist` but no root build creates it. The README
points to nonexistent `index.ts`, omits `DATABASE_URL`, data/host/token settings,
the reader submodule, and the actual verification/type-generation workflows.

## Current state

- `README.md:3-13` is Bun-init boilerplate and says `bun run index.ts`.
- `ui/README.md` is Vite template documentation.
- `src/index.ts:77` serves `./ui/dist`.
- `.gitmodules:1` defines Foliate, which is not initialized in this checkout.
- `src/db/index.ts:5` requires `DATABASE_URL`.

## Commands you will need

`pnpm build`, `test -f ui/dist/index.html`, `pnpm check`, and a production HTTP
smoke test must succeed.

## Scope

**In scope**: root build/start/preflight scripts, authoritative README,
`.env.example` with non-secret placeholders, concise UI README redirect/removal,
clean-checkout smoke verification.

**Out of scope**: containers, deployment platform templates, publishing secrets.

## Steps

1. Ensure root `build` creates `ui/dist` and production start fails with a clear
   message if required configuration/build output is absent.
2. Add `.env.example` containing variable names and safe placeholders only:
   database, data path, port, host, optional remote token, Gemini credential name,
   and documented workload overrides.
3. Replace boilerplate with prerequisites, recursive clone/submodule setup, one
   pnpm install, development, build/start, check/test/typegen, storage, security,
   and troubleshooting instructions. Avoid duplicating a second UI manual.
4. Follow the README in a clean temporary checkout shape and smoke `/`, API
   health/known route, and static fallback. **Verify**: `pnpm check`.

## Done criteria

- [ ] `pnpm build` creates deployable UI output.
- [ ] Every documented command exists and was exercised.
- [ ] Required/optional environment variables are documented without secrets.
- [ ] Recursive submodule initialization is explicit.
- [ ] Production smoke and `pnpm check` pass.

## STOP conditions

Stop if production deployment intentionally serves the UI from another artifact;
document that contract instead of adding a conflicting local build.

## Maintenance notes

README commands are part of the verification contract; update them in the same
change whenever scripts or security defaults change.
