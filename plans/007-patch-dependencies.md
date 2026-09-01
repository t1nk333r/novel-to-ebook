# Plan 007: Patch reachable vulnerable dependencies

> **Executor instructions**: Update only reachable or directly exposed paths,
> preserve exporter behavior with fixtures, and update `plans/README.md`.
>
> **Drift check**: `git diff --stat 5b03d47..HEAD -- package.json ui/package.json pnpm-lock.yaml src ui/vite.config.ts tests`

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: `plans/001-standardize-workspace.md`, `plans/002-verification-baseline.md`
- **Category**: migration
- **Planned at**: commit `5b03d47`, 2026-08-30

## Why this matters

The production lock graph includes high/critical advisories on code paths that
parse books/images, invoke GenAI, and run the remotely exposed dev server. Unused
legacy dependencies also keep a critical EJS path in the graph.

## Current state

- `pnpm-lock.yaml:3925` resolves `fast-xml-parser@5.4.2` through EPUB parsing.
- `pnpm-lock.yaml:5464` resolves vulnerable `protobufjs@7.5.4` through GenAI.
- `pnpm-lock.yaml:5887` resolves `sharp@0.34.5`; scanning processes book covers.
- `pnpm-lock.yaml:6418` resolves `vite@7.3.1`; dev config allows all hosts.
- `package.json:39` lists unused `epub-gen`; UI also lists unused exporter/theme
  dependencies.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Audit | `pnpm audit --prod` | no reachable critical/high advisory retained |
| Why | `pnpm why epub-gen ejs protobufjs fast-xml-parser sharp vite` | only intended paths remain |
| Check | `pnpm check` | exit 0 |

## Scope

**In scope**: manifests/lockfile, compatibility edits required by Hono 4.13.5,
Vite 8.2.2, Sharp 0.35.4, Google GenAI 2.19.0, and patched transitives; EPUB
export/scan fixtures.

**Out of scope**: unrelated minor churn, swapping the active pre-release EPUB
exporter without behavioral equivalence, low/moderate unreachable advisories.

## Steps

1. Add fixtures that scan one EPUB cover and export a book with cover/images.
2. Remove confirmed-unused `epub-gen`, its types, and unused UI dependencies.
3. Update the direct parents to current compatible patched stable versions; use
   narrow pnpm overrides only when a direct parent has not yet released a safe
   graph and the override passes its integration fixture.
4. Re-run audit and document any remaining high/critical item with reachability
   evidence. **Verify**: `pnpm check && pnpm audit --prod` meets the table above.

## Done criteria

- [ ] Active book parsing/image processing and GenAI dependency paths are patched.
- [ ] Unused `epub-gen`/EJS path is absent.
- [ ] Vite dev-server high advisories are patched.
- [ ] EPUB scan/export fixtures and `pnpm check` pass.

## STOP conditions

Stop if the active EPUB exporter has no installable compatible graph and replacing
it changes generated structure; report the fixture diff rather than shipping it.

## Maintenance notes

Treat audit output by reachability, not raw count; record why any retained
high/critical path cannot execute.
