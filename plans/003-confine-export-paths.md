# Plan 003: Confine EPUB exports to the configured library root

> **Executor instructions**: Test traversal first, implement the smallest shared
> path policy, and update `plans/README.md`.
>
> **Drift check**: `git diff --stat 5b03d47..HEAD -- src/app/projects/schema.ts src/app/projects/routes.ts src/app/projects/types.ts tests`

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: `plans/002-verification-baseline.md`
- **Category**: security
- **Planned at**: commit `5b03d47`, 2026-08-30

## Why this matters

Project configuration and titles currently determine a filesystem destination
without containment checks. Export must never create or overwrite a file outside
the canonical `DATA_PATH`, regardless of separators, traversal, or symlinks.

## Current state

- `src/app/projects/schema.ts:113` defines `config` as `z.any()`.
- `src/app/projects/routes.ts:263-270` joins `config.outDir` and project title.
- `src/app/projects/routes.ts:297` writes synchronously to the unchecked result.
- Existing route errors use `HTTPError` from `src/lib/error.ts`.

## Commands you will need

`pnpm test -- export-path` and `pnpm check` must both exit 0.

## Scope

**In scope**: project config schema/types, export destination calculation,
security regression tests.

**Out of scope**: upload support, renaming existing exported books, storage UI.

## Steps

1. Add failing tests for `..`, absolute output directories, title separators,
   empty/unsafe filenames, and a normal nested directory. **Verify**: targeted
   tests fail only for the unsafe current behavior.
2. Define a concrete project config schema and a helper that resolves a sanitized
   filename beneath a canonical root, rejecting escape and symlink-parent policy
   violations with a 400 response. **Verify**: targeted tests pass.
3. Route all export writes through the helper and use async filesystem calls.
   **Verify**: `pnpm check` exits 0.

## Done criteria

- [ ] Unsafe `outDir` and title values cannot escape `DATA_PATH`.
- [ ] A valid nested output directory still exports.
- [ ] No `z.any()` remains for project config.
- [ ] `pnpm check` passes.

## STOP conditions

Stop if existing persisted configs intentionally contain absolute paths; report
the affected shape and request a migration policy.

## Maintenance notes

Any future upload/import destination must reuse this containment policy.
