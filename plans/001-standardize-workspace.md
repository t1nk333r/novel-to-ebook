# Plan 001: Standardize package management and workspace discovery

> **Executor instructions**: Follow each step and verification gate. Update the
> status row in `plans/README.md` when complete.
>
> **Drift check**: `git diff --stat 5b03d47..HEAD -- package.json pnpm-workspace.yaml pnpm-lock.yaml ui/package.json ui/pnpm-lock.yaml`
> If the manifests or lockfile importers no longer match the current-state facts,
> stop and report before resolving dependencies.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `5b03d47`, 2026-08-30

## Why this matters

The repository commits pnpm lockfiles but mixes Bun, npm, and pnpm commands. The
workspace file does not include `ui`, while the root and UI maintain competing
lock graphs. A clean checkout therefore has no authoritative install procedure.

## Current state

- `pnpm-workspace.yaml:1` contains only `onlyBuiltDependencies`.
- `package.json:7-13` delegates across Bun and npm without a `packageManager`.
- `pnpm-lock.yaml` contains a UI importer while `ui/pnpm-lock.yaml` duplicates it.
- `pnpm list -r --depth -1` currently discovers only `storvi`, not `ui`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Registry | `npm view pnpm version && npm view bun version` | `11.24.0` and `1.4.0` or newer compatible stable releases |
| Resolve | `pnpm install --lockfile-only` | exit 0; one root lockfile updated |
| Discover | `pnpm list -r --depth -1` | lists both `storvi` and `ui` |

## Scope

**In scope**: `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`,
`ui/package.json`, removal of `ui/pnpm-lock.yaml`.

**Out of scope**: application behavior, broad dependency upgrades, source files.

## Git workflow

Work on the current branch. Match conventional messages such as
`chore: start script add env prod`. Do not push or commit unless instructed.

## Steps

1. Declare pnpm 11.24.0 in root `packageManager`, add `ui` under workspace
   `packages`, and add Bun 1.4.0 as the reproducible runtime dev dependency.
   **Verify**: `pnpm list -r --depth -1` lists two projects.
2. Replace `cd ui && npm ...` scripts with pnpm workspace/filter invocations.
   Keep Bun as the server runtime. **Verify**: `pnpm --filter ui run` lists the UI
   scripts and no root script contains `cd ui` or `npm run`.
3. Remove the nested lockfile and regenerate only `pnpm-lock.yaml`.
   **Verify**: `test ! -e ui/pnpm-lock.yaml && pnpm install --frozen-lockfile`
   exits 0.

## Test plan

No application test is required. Verification is a frozen clean dependency
resolution and two-project workspace discovery.

## Done criteria

- [ ] `pnpm list -r --depth -1` lists root and UI.
- [ ] `pnpm install --frozen-lockfile` exits 0.
- [ ] Only one pnpm lockfile remains.
- [ ] Root scripts use the declared package manager consistently.

## STOP conditions

- Stop if current pnpm cannot resolve a native dependency without changing its
  supported build policy.
- Stop if the UI importer in the root lockfile cannot be reconciled with
  `ui/package.json` without an unexplained major upgrade.

## Maintenance notes

Future dependency changes must be made from the repository root so the single
lock graph remains authoritative.
