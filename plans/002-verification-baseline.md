# Plan 002: Establish repository-wide verification and CI

> **Executor instructions**: Follow every step, preserve failing regression
> tests until the relevant later plan fixes them, and update `plans/README.md`.
>
> **Drift check**: `git diff --stat 5b03d47..HEAD -- package.json ui/package.json tsconfig.json ui/tsconfig.app.json .github tests src ui/src`
> Stop if a test framework or CI workflow was added independently.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: `plans/001-standardize-workspace.md`
- **Category**: tests
- **Planned at**: commit `5b03d47`, 2026-08-30

## Why this matters

Storvi has no test files, CI workflow, backend check script, or aggregate command.
Every behavioral fix needs a deterministic machine-checkable gate before it can
be considered safe.

## Current state

- `package.json:6-13` contains start/dev/type-generation scripts only.
- `ui/package.json:8-9` has UI build and lint, but no tests.
- No tracked file matches `*.test.*`, `*.spec.*`, or `.github/workflows/*`.
- Server TypeScript is strict in `tsconfig.json`; UI build runs `tsc -b`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Tests | `pnpm test` | exit 0; Bun reports all tests passed |
| Types | `pnpm typecheck` | exit 0, no errors |
| Lint | `pnpm lint` | exit 0 |
| Build | `pnpm build` | exit 0; `ui/dist/index.html` exists |
| Aggregate | `pnpm check` | exit 0 |

## Scope

**In scope**: root/UI manifests, `.github/workflows/ci.yml`, test support under
`tests/`, and minimal source seam changes strictly required for deterministic
tests.

**Out of scope**: fixing the behavioral findings assigned to plans 003-017,
coverage percentage enforcement, browser E2E infrastructure.

## Steps

1. Add root `test`, `typecheck`, `lint`, `build`, and `check` scripts. Use
   `bun test` through the workspace-installed Bun runtime; keep type generation
   separate because it mutates a tracked schema. **Verify**: `pnpm run` lists all
   five commands.
2. Add deterministic tests for pure utilities and a temporary-database/server
   smoke seam that can grow in later plans. Tests must not use the public network
   or the user's real data path. **Verify**: `pnpm test` passes.
3. Add a CI workflow using pnpm 11.24.0 and the declared runtime, frozen install,
   then `pnpm check`. **Verify**: workflow YAML contains
   `pnpm install --frozen-lockfile` and `pnpm check`.

## Test plan

Initial tests cover one HTML-cleaning case, queue behavior, and configuration
validation. Later plans add regression cases beside these tests.

## Done criteria

- [ ] `pnpm check` exits 0 from an installed clean checkout.
- [ ] CI runs the exact same aggregate command.
- [ ] Tests use temporary paths/databases and no live network.
- [ ] Type generation is not part of ordinary checks.

## STOP conditions

- Stop if testing requires real browser downloads or a live Gemini credential.
- Stop if baseline type errors require behavior changes assigned to later plans;
  report them rather than weakening strictness.

## Maintenance notes

Every later bug plan must add its regression test to this shared gate.
