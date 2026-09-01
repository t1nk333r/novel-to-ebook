# Plan 006: Complete migrations before scans and traffic

> **Executor instructions**: Make startup fail fast and update
> `plans/README.md` after all gates pass.
>
> **Drift check**: `git diff --stat 5b03d47..HEAD -- src/db/migrate.ts src/index.ts src/scheduler.ts tests`

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: `plans/002-verification-baseline.md`
- **Category**: bug
- **Planned at**: commit `5b03d47`, 2026-08-30

## Why this matters

The initial library scan queries SQLite before migrations complete, and the
listener accepts requests regardless of migration failure. Startup must establish
the database invariant before scheduling work or serving traffic.

## Current state

- `src/db/migrate.ts:14` calls `migrateToLatest()` without awaiting it.
- `src/index.ts:82-83` starts scanning before calling migration.
- `src/index.ts:85` starts the server synchronously afterward.

## Commands you will need

`pnpm test -- startup`, `pnpm typecheck`, and `pnpm check` must exit 0.

## Scope

**In scope**: migration result handling, application bootstrap ordering, scheduler
initialization, startup integration tests.

**Out of scope**: new database migrations or schema changes.

## Steps

1. Add a test with deferred/failing migrations proving scan and serve hooks are
   not invoked before success and are never invoked after failure.
2. Return and await `migrateToLatest()`, inspect its error result, and throw a
   contextual startup error.
3. Extract/structure an async bootstrap that migrates, then initializes scanning,
   then listens. Attach top-level failure logging and a nonzero exit path.
   **Verify**: `pnpm check` passes.

## Done criteria

- [ ] Fresh-database startup creates tables before scanning.
- [ ] Migration failure prevents the listener from starting.
- [ ] No migration promise is left unawaited.
- [ ] `pnpm check` passes.

## STOP conditions

Stop if the Kysely dialect cannot migrate in the test environment without a real
user database; introduce dependency injection, never point tests at `DATABASE_URL`.

## Maintenance notes

All future startup prerequisites should be inserted into the same ordered
bootstrap rather than added as top-level fire-and-forget calls.
