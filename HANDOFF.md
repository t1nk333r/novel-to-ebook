# Storvi implementation handoff

## Baseline

- Repository: `novel-to-ebook`
- Audit baseline: commit `5b03d47`
- Workflow: `improved-dev`
- Package manager: pnpm 11 workspace with one root lockfile
- Runtime target: Bun 1.4+, Node 24+

## Completed

The implementation covers plans 001–014 and 018:

- Standardized pnpm workspace scripts, lockfile, engines, CI, and checks.
- Added deterministic Bun tests, server/UI typechecks, lint, and production build gates.
- Added loopback binding by default and bearer authentication for non-loopback hosts.
- Added request-size, selector, browser-action, import, screenshot, fetch, and retry limits.
- Added SSRF-safe outbound URL validation, redirect checks, DNS/IP filtering, fetch timeouts, and response-size limits.
- Confined EPUB export destinations beneath `DATA_PATH` with traversal/symlink checks.
- Awaited SQLite migrations before scheduler startup and traffic acceptance.
- Updated reachable dependencies and removed unused generator dependencies.
- Fixed snapshot timer cleanup, font retry off-by-one behavior, chapter update scope, chapter reorder validation/serialization, and overlapping rescan publication.
- Added production preflight validation and replaced boilerplate documentation.

Key implementation files include:

- `src/lib/auth.ts`
- `src/lib/network-policy.ts`
- `src/lib/export-path.ts`
- `src/lib/limits.ts`
- `src/lib/bounded-executor.ts`
- `src/lib/periodic-task.ts`
- `src/preflight.ts`
- `tests/`
- `.github/workflows/ci.yml`
- `.env.example`

## Verification

Passing checks:

- Bun tests: 6 passed.
- Server TypeScript check: passed.
- UI TypeScript check: passed.
- UI ESLint: 0 errors, 25 existing warnings.
- Vite production build: passed.
- `git diff --check`: passed.

The production UI bundle still emits a size warning; route code splitting was intentionally deferred because it was not part of the confirmed remediation scope.

## Known limitation

Local `pnpm check` cannot complete under the current Node 26 environment because `better-sqlite3` has no compatible prebuilt binary and its native compilation fails. CI uses Node 24, the documented target. Direct tests, typechecks, lint, and build were run successfully.

## Remaining plans

Plans 015–017 remain TODO:

1. Prevent stale reader loads from winning navigation.
2. Make library scanning incremental and concurrency-bounded.
3. Refresh cached books conditionally using HTTP validators instead of re-downloading them.

These should be implemented with focused characterization tests before changing the reader/offline and library data flows.

## Deferred product directions

Uploads, next-chapter crawling, and in-book search were intentionally excluded from the remediation implementation.

## Recommended next commands

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm build
```

For production, copy `.env.example`, set `DATABASE_URL` and `DATA_PATH`, and set a strong `API_TOKEN` whenever `HOST` is not loopback.
