# Storvi implementation handoff

Written 2026-09-02, describing the repository at commit `27de206` on branch
`remediation/plans-001-018`.

---

## 1. State in one screen

```
main                        5b03d47   untouched, nothing pushed
remediation/plans-001-018   27de206   all work lives here
```

| Gate | Result |
|---|---|
| `bun test` | 41 pass, 0 fail, 8 files |
| `pnpm typecheck` | clean (server + UI) |
| `pnpm lint` | 0 errors, 23 warnings |
| `pnpm build` | `ui/dist/index.html` present |

Plans 001–007, 009–015, 017–019 are done. Plans 004 and 008 are **partial**.
Plans 016, 020, 021, 022 are TODO.

A container is running and serving on `0.0.0.0:3000`, but it was **built before
the merges** — none of the merged work is live yet.

---

## 2. How to run anything

Do these first or you will lose time to environment failures that look like code
failures.

```bash
export PATH="$HOME/.local/share/mise/installs/bun/1.4.0/bin:$PATH"
pnpm install --frozen-lockfile --ignore-scripts
git submodule update --init --recursive     # only if pnpm build fails
```

- **Bun is not on `PATH`.** It is installed via mise (1.4.0) with no global
  version pinned. Everything (`pnpm test`, `pnpm check`) runs through it.
- **`--ignore-scripts` is required.** `better-sqlite3@12.6.2`'s native addon does
  not compile against Node 26's V8 headers. It is a devDependency used only by
  `typegen:server` and imported nowhere in `src/`. **Do not** edit
  `package.json`, `pnpm-workspace.yaml`, or the lockfile to work around this.
- **`pnpm build` needs the foliate submodule.** Failure looks like `ENOENT` on
  `ui/src/lib/foliate-js/view.js`.
- **Docker requires sudo.** The user is not in the `docker` group.

### Test-writing traps

- Anything importing `src/app/projects/utils.ts` or a repository transitively
  pulls `src/db/index.ts`, which **throws at module load** if `DATABASE_URL` is
  unset. `bunfig.toml` preloads `tests/setup.ts`, which sets it to a temp path
  when absent. Never create a `.env` in the repo.
- **Never leave `DATABASE_URL` pointing at a directory your test deletes.** That
  was a real bug — see §4.
- **`expect(promise).rejects.toThrow()` hangs under Bun 1.4.0** when the promise
  resolves through the `kysely-bun-worker` Worker dialect. It does not fail; it
  hangs until the 5000 ms timeout. Use a try/catch helper —
  `tests/chapter-order.test.ts` has `assertRejects` with a comment explaining why.

---

## 3. Plan status

| Plan | Title | Status |
|---|---|---|
| 001 | Standardize pnpm workspace | DONE |
| 002 | Verification baseline and CI | DONE — suite is thin, see below |
| 003 | Confine EPUB exports | DONE |
| 004 | Loopback default + bearer auth | **PARTIAL** — UI cannot send the token |
| 005 | SSRF-safe outbound URLs | DONE |
| 006 | Migrations before traffic | DONE |
| 007 | Patch dependencies | DONE |
| 008 | Bound workloads | **PARTIAL** — step 3 only |
| 009 | Rescan race safety | DONE |
| 010 | Block Element removes | DONE, merged |
| 011 | Font attempt order | DONE |
| 012 | Snapshot timer cleanup | DONE |
| 013 | Chapter update fields | DONE |
| 014 | Serialize chapter order | DONE, merged |
| 015 | Reader load generation | DONE, merged |
| 016 | Incremental library scan | TODO |
| 017 | Conditional book refresh | DONE, merged |
| 018 | Production build + docs | DONE |
| 019 | Selector precision | DONE, merged |
| 020 | Multi-select content selectors | TODO — depends on 019 (satisfied) |
| 021 | Iframe selectors | TODO — depends on 020 |
| 022 | Ollama page parser | TODO — depends on 021 |

`plans/README.md` holds the full reconciliation log with per-plan evidence.

### The two partials

**Plan 004 — the UI cannot authenticate.** `ui/src/lib/api.ts` builds its fetch
client with `baseUrl` and one response hook. `grep -rn "API_TOKEN\|Bearer\|apiToken"
ui/src --include=*.ts --include=*.tsx` returns nothing. Setting `API_TOKEN` makes
every browser API call 401 while `curl` still works, so token auth is currently
unusable and the deployment runs open. This is the highest-value gap.

**Plan 008 — `src/lib/bounded-executor.ts` is an orphan.** Limits and Zod maxima
landed, but `grep -rn "BoundedExecutor" src/` matches only its own definition. No
browser or AI call passes through a semaphore, so "concurrency slots release on
success, error, and abort" cannot hold. Step 3 is the remaining work.

### Test suite

10 tests across 3 files at session start; **41 across 8 files** now. Still thin.
Plans 003–014 named test targets (`auth`, `startup`, `rescan`, `font-attempts`)
that were never written. A green `pnpm check` is weak evidence on its own.

---

## 4. Two bugs worth knowing about

**`reorderChapters` was broken in production.** `index` is a reserved SQLite
keyword and the code passed it unquoted:

```
"index + 1000000"     -> ERROR: near "index": syntax error
"\"index\" + 1000000" -> OK
```

Verified against `bun:sqlite`. Every chapter drag-reorder threw a 500. It
survived because no test covered it, and because a reconcile read the function's
structure and pronounced it correct **without executing it**. Fixed in `fe75996`.

**A test-isolation bug that only existed after merging.** `tests/book-cache.test.ts`
(plan 017) pointed `process.env.DATABASE_URL` into its temp dir, then deleted that
dir in `afterAll` without restoring the variable. Every later test file failed to
open a database. Plans 014 and 017 were each green in isolation; only their
combination failed — and only in one file order, so an earlier trial merge passed
41/41 by luck. Fixed in `1091213`.

Both point the same way: **reading code is not verifying it, and one green run is
not proof.**

---

## 5. Trust the record carefully

Plans 008, 010, and 014 were all marked DONE while failing their own criteria, and
004 is partial. **Do not trust a DONE marking without re-checking.**

Two plan-authoring errors were caught by executors and corrected in `a179008`:

- **Plan 014** claimed `reorderChapters` was unimplemented. It already had a
  transaction, a `+1000000` offset, and id validation. The claim came from a
  truncated `grep -A6` that never showed those lines.
- **Plan 019** named the wrong failing case. Measured against live code, case 2
  (`div.article p:nth-of-type(3)`) matches 1 element and was already correct;
  case 3 (`div.chapter div.body p`) matches 3 and is the real defect. The deepest
  segment does get `:nth-of-type`; ambiguous ancestors do not.

---

## 6. Deployment

Running now, reachable at:

- `http://127.0.0.1:3000`
- `http://100.68.180.101:3000` / `http://luna.rudd-fish.ts.net:3000` (tailnet)

Built from the multi-stage `Dockerfile` (Node 24 builds the UI, `oven/bun:1.4-debian`
runs it, distro Chromium via `PUPPETEER_EXECUTABLE_PATH`). `docker-compose.yml`
publishes on `0.0.0.0:3000` at the user's explicit instruction.

**It runs unauthenticated.** `ALLOW_INSECURE_BIND=1` permits a tokenless
non-loopback bind. The flag never disables `bearerAuth` — a configured token is
still enforced — but the UI cannot send one (plan 004), so a token is not a usable
option today. Anything that can route to port 3000, including every tailnet
device, has full control of the browser-automation and AI endpoints.

**No PWA/offline over plain HTTP.** Service workers need a secure context, so
offline caching works at `127.0.0.1` but not from other devices.
`tailscale serve --bg 3000` would add an HTTPS name without touching the container.

### Before you rebuild the container

Plan 014's **migration 0002 renumbers every project's chapters** to a dense
0-based sequence. It preserves reading order, but it rewrites rows. **Back up the
`storvi-db` volume first.**

---

## 7. What to do next

**Immediately available, no decisions needed:**

1. **Clean up worktrees.** Four `.claude/worktrees/agent-*` remain registered and
   are fully merged: `git worktree remove <path>` for each, then add `.claude/`
   to `.gitignore` (it is currently untracked and unignored).
2. **Rebuild and redeploy** so the merged work is actually live (back up the DB
   volume first, per §6).
3. **Plan 020** — multi-select content selectors. Unblocked now that 019 landed.
4. **Plan 008 step 3** — wire `BoundedExecutor`.
5. **Plan 016** — incremental library scan.

**Needs a decision:**

6. **Plan 004's UI token transport.** Not yet planned. Until it exists, the app
   cannot be run authenticated. Worth writing as plan 023.
7. **TrueNAS deployment.** Target confirmed: TrueNAS SCALE, RTX 3070 Ti (8 GB),
   driver 570.172.08, CUDA 12.8, GPU passthrough working, GPU shared with
   Jellyfin. Blockers in order:
   - `storvi:local` exists only on the dev machine's Docker daemon. TrueNAS
     cannot pull it — needs a GHCR push added to `.github/workflows/ci.yml`, or
     a build on the NAS.
   - `docker-compose.yml` has no `ollama` service; that lives only in plan 022.
   - TrueNAS's supported path is **Apps → Custom App → Install via YAML**, not
     `docker compose` over SSH. Both services must be in one custom app or
     service-name DNS and `depends_on` will not work.
   - A `dockhand` MCP server was expected but is not connected.

**Chain constraint:** 019 → 020 → 021 → 022 all touch `src/app/projects/utils.ts`
and must run in that order. None can be parallelized.

---

## 8. If you dispatch executor agents

Five Sonnet executors ran this session. What went wrong, so it does not again:

- **Worktrees branch from the repo's HEAD at creation, which may predate your
  commit.** All five were branched from `5b03d47` and had no `plans/`, no
  `tests/`, no `pnpm check`. Fix without re-dispatching: `git reset --hard <branch>`
  inside the worktree — worktrees share the object store, so the branch is
  already reachable.
- **Commit plan corrections before telling an executor to pull them.** Two
  executors were told to `git checkout <branch> -- plans/NNN.md` while the
  corrections were still uncommitted, and silently got stale files.
- **An executor can commit to your branch by accident.** Plan 015's executor had
  its working directory shift mid-run and committed to
  `remediation/plans-001-018` rather than its worktree. Check `git log` on your
  own branch after a dispatch.
- **Verify merged results, not just per-branch results.** See the isolation bug
  in §4.

The constraint to restate in **any** plan touching `src/app/projects/utils.ts`:

> `getSelector` exists **twice** — inline inside `extractElements`, and as a
> module-level export. The duplication is deliberate: `extractElements` is
> serialized into the browser by `page.evaluate` and cannot reference Node module
> scope. Merging them produces a runtime `ReferenceError` inside the page that
> **no typecheck and no unit test will catch**.
