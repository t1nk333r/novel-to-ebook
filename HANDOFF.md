# Storvi implementation handoff

Updated: 2026-09-02. Supersedes the previous handoff, which claimed plans
001–014 and 018 were complete — a reconcile disproved that (see "Corrections to
the record").

## Where things are right now

- Working branch: **`remediation/plans-001-018`** at `a179008`.
- `main` is untouched at `5b03d47`. Nothing has been pushed.
- Four approved plan branches are **merged nowhere** — they live in agent
  worktrees under `.claude/worktrees/` and await a merge decision.
- A Storvi container is running and serving on `0.0.0.0:3000`.

### Branch topology

```
main                        5b03d47   (untouched)
remediation/plans-001-018   a179008   <- you are here
  ├─ fb02581  plans 001-018 remediation + docker + ALLOW_INSECURE_BIND
  ├─ e852fa8  plan 015 (landed here by accident — see note)
  └─ a179008  plan corrections (014, 019)

worktree-agent-ac2ab66f78269c7cd   8c065aa   plan 010   APPROVED, unmerged
worktree-agent-a9fc71a370bb6a5d5   e0320ee   plan 017   APPROVED, unmerged
worktree-agent-ae37832d828e33563   d2aa64f   plan 019   APPROVED, unmerged
worktree-agent-ae276296e09c19dc0   fe75996   plan 014   APPROVED, unmerged
```

**Plan 015 landed on the working branch by accident.** Its executor's working
directory shifted mid-run and it committed to `remediation/plans-001-018`
instead of its own worktree. The work was reviewed and is sound, but it bypassed
the merge gate. To drop it: `git reset --hard fb02581`.

### Merging

All four were merged into a throwaway worktree and verified together before
being discarded — **zero conflicts**, `bun test` 41 pass / 0 fail across 8 files,
`tsc` clean for both server and UI. This is the tested order:

```bash
git merge --no-ff worktree-agent-ac2ab66f78269c7cd   # 010
git merge --no-ff worktree-agent-a9fc71a370bb6a5d5   # 017
git merge --no-ff worktree-agent-ae37832d828e33563   # 019
git merge --no-ff worktree-agent-ae276296e09c19dc0   # 014
```

Each branch was also verified in isolation: 010 → 13 tests, 015 → 16, 017 → 19,
019 → 16, 014 → 17, against a 10-test baseline.

## Plan status

| Plan | Title | Status |
|---|---|---|
| 001 | Standardize pnpm workspace | DONE, verified |
| 002 | Verification baseline and CI | DONE, verified (suite is thin — see below) |
| 003 | Confine EPUB exports | DONE, verified |
| 004 | Loopback default + bearer auth | **PARTIAL** — UI never sends the token |
| 005 | SSRF-safe outbound URLs | DONE, verified |
| 006 | Migrations before traffic | DONE, verified |
| 007 | Patch dependencies | DONE, verified |
| 008 | Bound workloads | **PARTIAL** — step 3 only |
| 009 | Rescan race safety | DONE, verified |
| 010 | Block Element removes | APPROVED, unmerged |
| 011 | Font attempt order | DONE, verified |
| 012 | Snapshot timer cleanup | DONE, verified |
| 013 | Chapter update fields | DONE, verified |
| 014 | Serialize chapter order | APPROVED, unmerged |
| 015 | Reader load generation | APPROVED, on branch |
| 016 | Incremental library scan | TODO |
| 017 | Conditional book refresh | APPROVED, unmerged |
| 018 | Production build + docs | DONE, verified |
| 019 | Selector precision | APPROVED, unmerged |
| 020 | Multi-select content selectors | TODO — depends on 019 |
| 021 | Iframe selectors | TODO — depends on 020 |
| 022 | Ollama page parser | TODO — depends on 021 |

`plans/README.md` carries the full reconciliation log with per-plan evidence.

### The two partials

**Plan 008 — `src/lib/bounded-executor.ts` is an orphan.** Limits and Zod maxima
landed, but `grep -rn "BoundedExecutor" src/` matches only its own definition.
No browser or AI call passes through a semaphore, so the done criterion
"concurrency slots release on success, error, and abort" cannot hold. Step 3 is
the remaining work.

**Plan 004 — the UI cannot authenticate.** `ui/src/lib/api.ts` builds its fetch
client with `baseUrl` and one response hook; `grep -rn "API_TOKEN\|Bearer\|apiToken"
ui/src --include=*.ts --include=*.tsx` returns nothing. Setting `API_TOKEN` makes
every browser API call 401 while `curl` still works. This is why the Docker
deployment runs unauthenticated (below).

## A real production bug was found

`reorderChapters` in `src/app/projects/chapters/repository.ts` was **broken** —
`index` is a reserved SQLite keyword and the code passed it unquoted:

```
"index + 1000000"     -> ERROR: near "index": syntax error
"\"index\" + 1000000" -> OK
```

Verified directly against `bun:sqlite`. Every chapter drag-reorder threw a 500.
It survived because no test covered it, and because a prior reconcile read the
function's structure and pronounced it correct **without executing it**. The fix
is in plan 014's branch (`fe75996`), unmerged.

Lesson worth carrying: reading code is not verifying code.

## Corrections to the record

Three plans were marked DONE while failing their own criteria — 008, 010, 014 —
and plan 004 is partial. Do not trust a DONE marking without re-checking.

Two plan-authoring errors were caught by executors and corrected in `a179008`:

- **Plan 014** claimed `reorderChapters` was unimplemented. It already had a
  transaction, a `+1000000` offset, and id validation. The claim came from a
  truncated `grep -A6` that never showed those lines.
- **Plan 019** named the wrong failing test case. Measured against live code,
  case 2 (`div.article p:nth-of-type(3)`) already matches 1 element and is
  correct; case 3 (`div.chapter div.body p`) matches 3 and is the real defect.
  The deepest segment does get `:nth-of-type`; ambiguous ancestors do not.

## Environment gotchas

These cost several agent-hours. Read before starting.

- **Bun is not on `PATH`.** Installed via mise but no global version pinned:
  `export PATH="$HOME/.local/share/mise/installs/bun/1.4.0/bin:$PATH"`.
- **`pnpm install --frozen-lockfile` fails.** `better-sqlite3@12.6.2`'s native
  addon will not compile against Node 26's V8 headers. It is a devDependency used
  only by `typegen:server` and imported nowhere in `src/`. Use
  `--ignore-scripts`, then `pnpm rebuild` what you actually need. **Do not**
  change `package.json`, `pnpm-workspace.yaml`, or the lockfile to work around it.
- **`pnpm check`'s build stage needs the submodule.** If it fails with `ENOENT`
  on `ui/src/lib/foliate-js/view.js`, run `git submodule update --init --recursive`.
- **`DATABASE_URL` must be set for many tests.** Anything importing
  `src/app/projects/utils.ts` or the repositories transitively pulls
  `src/db/index.ts`, which throws at module load if unset. Plan 014's branch adds
  `bunfig.toml` + `tests/setup.ts` to handle this globally; before that merges,
  set it per-invocation. Never create a `.env` in the repo.
- **`expect(promise).rejects.toThrow()` hangs under Bun 1.4.0** when the promise
  resolves through the `kysely-bun-worker` Worker dialect — it does not fail, it
  hangs until the 5000 ms per-test timeout. Use a plain try/catch helper. Plan
  014's `tests/chapter-order.test.ts` has one (`assertRejects`) with a comment.
- **Docker needs sudo.** The user is not in the `docker` group.

## Test suite

Baseline before this session was 10 tests across 3 files. With all four branches
merged: **41 tests across 8 files**. Still thin relative to the codebase — plans
003–014 named test targets (`auth`, `startup`, `rescan`, `font-attempts`) that
were never written. `pnpm check` passing is weak evidence on its own.

## Deployment state

A container is **running now** and reachable at:

- `http://127.0.0.1:3000`
- `http://100.68.180.101:3000` and `http://luna.rudd-fish.ts.net:3000` (tailnet)

Built from `Dockerfile` (multi-stage: Node 24 builds the UI, `oven/bun:1.4-debian`
runs it, distro Chromium via `PUPPETEER_EXECUTABLE_PATH`). `docker-compose.yml`
publishes on `0.0.0.0:3000` at the user's explicit instruction.

**It runs unauthenticated.** `ALLOW_INSECURE_BIND=1` (added to `src/lib/auth.ts`
this session, with four tests in `tests/security-boundaries.test.ts`) permits a
tokenless non-loopback bind. The flag never disables `bearerAuth` — a token that
is set is still enforced — but the UI cannot send one (plan 004 gap), so a token
is not currently a usable option. Anything that can route to port 3000, including
every tailnet device, has full control of the browser-automation and AI endpoints.

Known limitation: **no PWA/offline over plain HTTP.** Service workers require a
secure context, so offline book caching works at `127.0.0.1` but not from other
devices over the tailnet. `tailscale serve --bg 3000` would add an HTTPS name
without changing the container.

## Open decisions

1. **Merge the four approved branches?** Commands above. Back up
   `storvi.sqlite` first — plan 014's migration 0002 renumbers every project's
   chapters to a dense 0-based sequence (order-preserving, but it rewrites rows).
2. **Plan 004's UI token transport** — the gap that forces unauthenticated
   operation. Not yet planned.
3. **Plan 008 step 3** — wire `BoundedExecutor` so the orphan stops being one.
4. **Deploy to TrueNAS.** Target is TrueNAS SCALE, RTX 3070 Ti (8 GB), driver
   570.172.08, CUDA 12.8, GPU passthrough confirmed. Also runs Jellyfin, so the
   GPU is shared. Blockers, in order:
   - The `storvi:local` image exists only on the dev machine's Docker daemon.
     TrueNAS cannot pull it — needs a registry push (GHCR, added to
     `.github/workflows/ci.yml`) or a build on the NAS.
   - `docker-compose.yml` has no `ollama` service yet; that snippet lives only in
     plan 022.
   - TrueNAS's supported path is Apps → Custom App → Install via YAML, **not**
     `docker compose` over SSH. Both services must be in one custom app or
     service-name DNS and `depends_on` will not work.
   - A `dockhand` MCP server was expected but is not connected in this session.
5. **Plans 019 → 020 → 021 → 022** is one strict chain through the selector
   pipeline. All touch `src/app/projects/utils.ts`; none can be parallelized.

## Executor notes

Five Sonnet executors ran in isolated worktrees this session. Two things worth
repeating for the next dispatch:

- **Worktrees branch from the repo's HEAD at creation, which may predate your
  commit.** All five were initially branched from `5b03d47` and had no `plans/`,
  no `tests/`, and no `pnpm check`. Fix without re-dispatching:
  `git reset --hard <branch>` inside the worktree — worktrees share the object
  store, so the branch is already reachable.
- **Commit plan corrections before telling an executor to pull them.** Two
  executors were told to `git checkout <branch> -- plans/NNN.md` while the
  corrections were still uncommitted in the working tree, and got stale files.

The critical constraint to restate in any plan touching `src/app/projects/utils.ts`:
`getSelector` exists **twice** — inline inside `extractElements` and as a
module-level export. The duplication is deliberate, because `extractElements` is
serialized into the browser by `page.evaluate` and cannot reference Node module
scope. Merging them produces a runtime `ReferenceError` inside the page that no
typecheck and no unit test will catch.
