# Plan 023: Let the web UI authenticate with the API bearer token

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan in
> `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat a505f3a..HEAD -- ui/src/lib/api.ts ui/src/lib/sse.ts ui/src/hooks/use-offline.ts ui/src/app.tsx ui/src/stores src/lib/auth.ts src/index.ts README.md`
> If any of those changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch, treat
> it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: `plans/004-protect-remote-api.md` (steps 1, 2 and 4 of that
  plan already landed; this plan completes its step 3)
- **Category**: security
- **Planned at**: commit `a505f3a`, 2026-09-02

## Why this matters

The server already enforces `Authorization: Bearer <API_TOKEN>` on `/api/*`, but
no code in `ui/src` ever sends that header. Setting `API_TOKEN` therefore makes
every browser request 401 while `curl` keeps working, so the only deployable
configuration today is an unauthenticated one (`ALLOW_INSECURE_BIND=1`). The
running deployment is published on `0.0.0.0:3000` and every tailnet device can
drive its browser-automation and AI endpoints. When this plan lands, an operator
can set `API_TOKEN`, open the UI, paste the token once per device, and use the
app normally — which is what makes remote deployment safe.

## Current state

### Server (do not modify — context only)

- `src/lib/auth.ts:56-72` — `bearerAuth(apiToken)`: reads the `authorization`
  request header, requires the exact `Bearer ` prefix, compares with
  `timingSafeEqual`, and on mismatch returns HTTP 401 with body
  `{ error: true, message: "Unauthorized", code: "UNAUTHORIZED" }`.
- `src/index.ts:27` — the middleware is mounted only when the host is non-loopback
  **and** a token is configured:

  ```ts
  if (serverConfig.remote && serverConfig.apiToken) api.use("*", bearerAuth(serverConfig.apiToken));
  ```

  Consequence you will rely on when testing: to exercise auth locally you must
  start the server with a non-loopback `HOST` *and* an `API_TOKEN`
  (`HOST=0.0.0.0 API_TOKEN=…`), then browse `http://127.0.0.1:3000`.
- `src/index.ts:87-89` — the UI is served from the same origin as the API:
  `app.route("/api", api)` then `app.get("*", serveStatic({ root: "./ui/dist" }))`.
  Static assets are public; only `/api/*` is authenticated.

### Every existing browser → API transport

There are exactly four. All four are JavaScript `fetch` calls, which is why a
request **header** is a sufficient transport and no cookie/query-string design is
needed:

1. `ui/src/lib/api.ts:8-20` — the generated `openapi-fetch` client used by all
   react-query hooks:

   ```ts
   export const API_URL = "/api";

   const api = createFetchClient<paths>({
     baseUrl: API_URL,
   });

   api.use({
     async onResponse({ response: res }) {
       if (!res.ok) {
         const json = await res.json().catch(() => {});
         const message = json?.message || res.statusText;
         throw new Error(message);
       }
     },
   });
   ```

2. `ui/src/lib/sse.ts:15-27` — the streaming client (a plain `fetch`, **not**
   `EventSource`, so headers are available):

   ```ts
   const { onMessage, body, headers, ...opts } = options || {};

   const res = await fetch(API_URL + url, {
     ...opts,
     method,
     body: typeof body === "object" ? JSON.stringify(body) : body,
     headers: {
       "Content-Type": typeof body === "object" ? "application/json" : undefined,
       ...(headers || {}),
     },
     responseType: "stream",
   } as never);
   if (!res.ok) throw new Error(res.statusText);
   ```

3. `ui/src/hooks/use-offline.ts:67-69` — image loader behind `OfflineImage`. Note
   the URL here is **not always** an API URL: callers pass `API_URL + item.cover`
   (`ui/src/app/library/components/library-list.tsx:146`,
   `ui/src/app/reader/components/sidebar.tsx:98`) but the same component type is
   used elsewhere with arbitrary URLs, so the token must be attached only for
   same-origin `/api` URLs:

   ```ts
   try {
     const res = await fetch(url);
     if (!res.ok) throw new Error("network");
   ```

4. `ui/src/hooks/use-offline.ts:98-113` — conditional book download (plan 017):

   ```ts
   const headers: Record<string, string> = {};
   if (conditional?.etag) headers["If-None-Match"] = conditional.etag;
   if (conditional?.lastModified) {
     headers["If-Modified-Since"] = conditional.lastModified;
   }

   const res = await fetch(
     API_URL + "/library/get?key=" + encodeURIComponent(key),
     Object.keys(headers).length ? { headers } : undefined,
   );

   if (res.status === 304) {
     return { status: "not-modified" };
   }

   if (!res.ok) throw new Error(res.statusText);
   ```

`ui/src/lib/utils.ts:60-67` (`saveAs`) downloads from an in-memory `Blob`, not a
URL, so exports need no change. There is no `EventSource`, no `<a download>`
pointing at `/api`, and no `<img src="/api/…">` — `OfflineImage`
(`ui/src/components/offline-image.tsx`) always goes through transport 3.

### Conventions to match

- **Persisted client state**: zustand + `persist`, one store per concern, key
  namespaced `app/…`. Exemplar `ui/src/stores/app.store.ts`:

  ```ts
  import { create } from "zustand";
  import { persist } from "zustand/middleware";

  type AppStore = { theme: "dark" | "light" };

  export const appStore = create<AppStore>()(
    persist<AppStore>(() => ({ theme: "dark" }), { name: "app/store" }),
  );

  export const setAppTheme = (appTheme: AppStore["theme"]) => {
    appStore.setState({ theme: appTheme });
  };
  ```

- **Modal state**: `createDisclosure()` from `ui/src/lib/store.ts` — returns
  `{ store, setOpen, setData, onOpen, useStore }`.
- **Dialog markup**: shadcn primitives, controlled by a disclosure. Exemplar
  `ui/src/app/projects/view/components/import-toc-dialog.tsx:220-227,389-399`:

  ```tsx
  const { open } = importTOCModal.useStore();
  …
  <Dialog open={open} onOpenChange={importTOCModal.setOpen}>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Import Table of Contents</DialogTitle>
        <DialogDescription>…</DialogDescription>
      </DialogHeader>
      …
      <DialogFooter className="mt-4">…</DialogFooter>
    </DialogContent>
  </Dialog>
  ```

  Available primitives: `@/components/ui/{dialog,button,input,label}.tsx`. There
  is no `alert.tsx` — render error text as a styled `<p>`.
- **Path alias**: `@/…` maps to `ui/src/…` (`ui/vite.config.ts:37-42`). Server
  tests cannot resolve that alias, which is why the pure helper in step 1 must
  import nothing.
- The UI has **no test runner**. Unit tests live at the repo root and run under
  `bun test` (`bunfig.toml` preloads `tests/setup.ts`); a root test may import a
  dependency-free file from `ui/src` by relative path.

## Commands you will need

Run these two lines first in every new shell — `bun` is not on `PATH` and the
native `better-sqlite3` devDependency does not compile under Node 26:

```bash
export PATH="$HOME/.local/share/mise/installs/bun/1.4.0/bin:$PATH"
pnpm install --frozen-lockfile --ignore-scripts
```

| Purpose | Command | Expected on success |
|---|---|---|
| Unit test (this plan) | `bun test tests/api-auth-transport.test.ts` | all pass |
| Full test suite | `pnpm test` | 41 existing + your new tests pass, 0 fail |
| Typecheck | `pnpm typecheck` | exit 0 (server + UI) |
| Lint | `pnpm lint` | exit 0, 0 errors (warnings pre-exist) |
| UI build | `pnpm build` | exit 0, writes `ui/dist/index.html` |
| Everything | `pnpm check` | exit 0 |

If `pnpm build` fails with `ENOENT` on `ui/src/lib/foliate-js/view.js`, run
`git submodule update --init --recursive` and retry. Never edit `package.json`,
`pnpm-workspace.yaml`, or the lockfile.

## Scope

**In scope**:

- `ui/src/lib/api-auth.ts` (create)
- `ui/src/stores/auth.store.ts` (create)
- `ui/src/components/token-gate.tsx` (create)
- `ui/src/lib/api.ts` (modify)
- `ui/src/lib/sse.ts` (modify)
- `ui/src/hooks/use-offline.ts` (modify)
- `ui/src/app.tsx` (modify)
- `tests/api-auth-transport.test.ts` (create)
- `README.md` (modify — replace the "Known gap" paragraph only)
- `plans/README.md` (status row)

**Out of scope** (do NOT touch):

- Anything under `src/` — the server side of plan 004 is complete and correct.
  In particular do **not** change the `serverConfig.remote && serverConfig.apiToken`
  condition at `src/index.ts:27`, and do not add a "is auth required?" endpoint:
  a 401 response is the only signal this plan needs, and a public config endpoint
  would leak deployment state to unauthenticated callers.
- Cookies, sessions, CSRF tokens, login endpoints, user accounts. Header-only.
- `ui/src/lib/utils.ts` — `proxyUrl` (line 69) is currently referenced nowhere;
  leave it alone.
- `ui/vite.config.ts` — do not add Workbox `runtimeCaching` for `/api`; caching
  authorized API responses in the service worker is a separate decision.
- `.env.example` — `API_TOKEN` is already documented there; no new variable.
- Any change to `ui/src/lib/api.schema.d.ts` (generated).

## Git workflow

- Work on the current branch (`remediation/plans-001-018`) unless you were given
  a worktree branch; if you are in a worktree whose `HEAD` predates `a505f3a`,
  run `git reset --hard <your branch>` first so `plans/` and `tests/` exist.
- Conventional commits, one per step or logical unit, plan number in the subject.
  Match `git log`: `feat: serialize chapter order allocation (plan 014)`,
  `fix(test): restore DATABASE_URL after book-cache tests`.
- Do not push and do not open a PR.

## Steps

### Step 1: Add the pure token-attachment helper

Create `ui/src/lib/api-auth.ts`. It must import **nothing** (a root `bun test`
imports it by relative path and cannot resolve the `@/` alias, `zustand`, or DOM
globals):

```ts
export const API_PREFIX = "/api";

/**
 * True only for same-origin `/api` requests. The token must never ride along on
 * a cross-origin fetch: `OfflineImage` is also used with arbitrary remote image
 * URLs, and leaking the bearer token to a third-party host would hand over full
 * control of this deployment.
 */
export function isApiRequest(url: string, origin: string): boolean {
  let base: URL;
  let target: URL;
  try {
    base = new URL(origin);
    target = new URL(url, base);
  } catch {
    return false;
  }

  if (target.origin !== base.origin) return false;
  return (
    target.pathname === API_PREFIX || target.pathname.startsWith(`${API_PREFIX}/`)
  );
}

export function apiAuthHeader(
  url: string,
  origin: string,
  token: string | null | undefined,
): { Authorization: string } | undefined {
  const trimmed = token?.trim();
  if (!trimmed) return undefined;
  if (!isApiRequest(url, origin)) return undefined;
  return { Authorization: `Bearer ${trimmed}` };
}
```

**Verify**: `pnpm typecheck` → exit 0.

### Step 2: Add the token store and the 401 signal

Create `ui/src/stores/auth.store.ts`, matching the `app.store.ts` shape:

```ts
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createDisclosure } from "@/lib/store";

type AuthStore = { token: string | null };

export const authStore = create<AuthStore>()(
  persist<AuthStore>(() => ({ token: null }), { name: "app/auth" }),
);

/** Open with `{ rejected: true }` when a token was sent and still got a 401. */
export const tokenGate = createDisclosure<{ rejected: boolean }>();

export function getApiToken() {
  return authStore.getState().token;
}

export function reportUnauthorized() {
  tokenGate.onOpen({ rejected: Boolean(getApiToken()) });
}
```

Never log, toast, or otherwise render the token value. `persist` with the default
`localStorage` storage hydrates synchronously, so `getApiToken()` is already
correct for the first request after a page load.

**Verify**: `pnpm typecheck` → exit 0.

### Step 3: Attach the header in all four transports

Each call site gets the header from `apiAuthHeader(...)` and reports 401s. Do not
introduce a second copy of the prefix/leak check.

**3a. `ui/src/lib/api.ts`** — extend the existing single `api.use({ … })` object
with an `onRequest` hook and a 401 branch (keep the existing error-throwing
behaviour intact):

```ts
import { apiAuthHeader } from "./api-auth";
import { getApiToken, reportUnauthorized } from "@/stores/auth.store";

api.use({
  onRequest({ request }) {
    const header = apiAuthHeader(
      request.url,
      window.location.origin,
      getApiToken(),
    );
    if (header) request.headers.set("Authorization", header.Authorization);
    return request;
  },
  async onResponse({ response: res }) {
    if (res.status === 401) reportUnauthorized();
    if (!res.ok) {
      const json = await res.json().catch(() => {});
      const message = json?.message || res.statusText;
      throw new Error(message);
    }
  },
});
```

**3b. `ui/src/lib/sse.ts`** — merge the header into the headers object it already
builds, and report 401 before the existing throw. The auth entry goes **after**
`...(headers || {})` so a caller cannot accidentally drop it:

```ts
const target = API_URL + url;
const res = await fetch(target, {
  ...opts,
  method,
  body: typeof body === "object" ? JSON.stringify(body) : body,
  headers: {
    "Content-Type": typeof body === "object" ? "application/json" : undefined,
    ...(headers || {}),
    ...apiAuthHeader(target, window.location.origin, getApiToken()),
  },
  responseType: "stream",
} as never);
if (res.status === 401) reportUnauthorized();
if (!res.ok) throw new Error(res.statusText);
```

**3c. `ui/src/hooks/use-offline.ts`, `getOfflineImage`** — the `url` argument may
be a third-party image URL, so pass it through the helper unchanged and only send
`headers` when one came back:

```ts
try {
  const header = apiAuthHeader(url, window.location.origin, getApiToken());
  const res = await fetch(url, header ? { headers: header } : undefined);
  if (res.status === 401) reportUnauthorized();
  if (!res.ok) throw new Error("network");
```

The existing `catch` that falls back to the IndexedDB copy must keep working: a
401 with a cached image still returns the cached blob.

**3d. `ui/src/hooks/use-offline.ts`, `fetchBook`** — add the header to the record
it already assembles, and handle 401 *before* the `304` check so an unauthorized
response is never mistaken for "not modified":

```ts
const target = API_URL + "/library/get?key=" + encodeURIComponent(key);
const headers: Record<string, string> = {
  ...apiAuthHeader(target, window.location.origin, getApiToken()),
};
if (conditional?.etag) headers["If-None-Match"] = conditional.etag;
if (conditional?.lastModified) {
  headers["If-Modified-Since"] = conditional.lastModified;
}

const res = await fetch(
  target,
  Object.keys(headers).length ? { headers } : undefined,
);

if (res.status === 401) {
  reportUnauthorized();
  throw new Error("Unauthorized");
}

if (res.status === 304) {
  return { status: "not-modified" };
}
```

**Verify**: `pnpm typecheck` → exit 0, and
`grep -rn "apiAuthHeader" ui/src` → matches in exactly four files
(`lib/api-auth.ts`, `lib/api.ts`, `lib/sse.ts`, `hooks/use-offline.ts`).

### Step 4: Add the token gate dialog

Create `ui/src/components/token-gate.tsx`: a controlled shadcn `Dialog` driven by
`tokenGate`, containing a `Label`, a masked `Input`, and a submit `Button`.

Requirements:

- `type="password"`, `autoComplete="off"`, `name="api-token"`. Keep the typed
  value in local `useState` — do not persist keystrokes.
- Copy: title "Authentication required"; description "This Storvi server requires
  an API token. Paste the value of `API_TOKEN` from the server's environment. It
  is stored in this browser only."
- When `data?.rejected` is true, also render "That token was rejected. Check
  `API_TOKEN` on the server." Never render the token itself.
- On submit with a non-empty value: `authStore.setState({ token })`, then
  `window.location.reload()`. A reload is deliberate — it is the cheapest correct
  way to re-issue every already-failed query, module-level image cache entry and
  in-flight stream with the new credential.
- Dismissable (`onOpenChange={tokenGate.setOpen}`): a user browsing
  IndexedDB-cached books offline must be able to close it. The next 401 reopens it.

Mount it in `ui/src/app.tsx` alongside the existing `ThemeProvider`:

```tsx
export default function App() {
  return (
    <>
      <Router />
      <ThemeProvider />
      <TokenGate />
    </>
  );
}
```

**Verify**: `pnpm lint` → 0 errors; `pnpm build` → exit 0.

### Step 5: Replace the README known-gap note

`README.md:75-78` currently ends with:

```markdown
**Known gap:** the web UI does not yet attach the bearer token to its requests,
so setting `API_TOKEN` currently makes the browser UI fail with 401 while the
API stays usable from `curl`. Until that lands, token auth is for API clients
only.
```

Replace that block with a short "Using the UI with a token" note stating: the UI
sends `Authorization: Bearer …` on every `/api` request; the first 401 opens a
prompt; the token is stored in that browser's `localStorage` under `app/auth` and
must be entered once per browser/device; clearing site data requires re-entry.
Add one sentence of honest risk: any script running on the page can read
`localStorage`, so treat the token as device-scoped and rotate it by changing
`API_TOKEN` on the server. Do not put a real token value anywhere.

**Verify**: `grep -n "Known gap" README.md` → no matches.

### Step 6: Verify against a running authenticated server

Build and start with auth actually enabled, using a throwaway token value of your
own choosing (never commit it, never paste it into any file):

```bash
pnpm build
HOST=0.0.0.0 API_TOKEN=<throwaway> DATA_PATH=./data DATABASE_URL=./storvi.sqlite \
  NODE_ENV=production bun run src/index.ts
```

Then confirm, in a browser at `http://127.0.0.1:3000`:

1. With no token stored (clear `localStorage` key `app/auth`): the library page
   shows the gate dialog.
2. Entering a wrong value: the page reloads and the gate reappears with the
   "rejected" message.
3. Entering the correct value: the library list loads **and** cover images render
   (that proves transport 3).
4. Open a book in the reader: it loads (transport 4), and a second open produces
   a 304 rather than a full download.
5. Open a project and run a Table-of-Contents import or a snapshot: progress
   streams (transport 2).
6. `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/library/list`
   → `401`; the same with `-H "Authorization: Bearer <throwaway>"` → `200`.

Record which of 1–6 you observed in your report. If you cannot drive a browser,
say so explicitly rather than claiming the check passed.

**Verify**: steps 1–6 observed, or the inability to run them reported.

## Test plan

Create `tests/api-auth-transport.test.ts`, modelled structurally on
`tests/selector.test.ts` (plain `import { describe, expect, test } from "bun:test"`,
no database, no fixtures). Import the helper by relative path:
`import { apiAuthHeader, isApiRequest } from "../ui/src/lib/api-auth";`

Cases (all against `origin = "http://localhost:3000"`):

1. Relative API path with a token → `{ Authorization: "Bearer t0ken-value" }`.
2. Absolute same-origin API URL (`http://localhost:3000/api/library/list`) → header present.
3. Cross-origin URL whose path starts with `/api` (`https://evil.example/api/x`)
   → `undefined`. **This is the leak guard; label the test accordingly.**
4. Same-origin non-API path (`/assets/app.js`, `/index.html`) → `undefined`.
5. Path that merely starts with the same characters (`/apiary/x`) → `undefined`.
6. No token (`null`, `undefined`, `""`, `"   "`) → `undefined` for an API URL.
7. Token with surrounding whitespace → trimmed in the emitted header.
8. Unparseable input (`isApiRequest("http://[", origin)`) → `false`, no throw.

Verification: `bun test tests/api-auth-transport.test.ts` → all pass;
`pnpm test` → 0 fail (the pre-existing 41 still pass; file order matters in this
suite, so run the whole suite, not just your file).

## Done criteria

ALL must hold:

- [ ] `pnpm test` exits 0; `tests/api-auth-transport.test.ts` exists and its 8
      cases pass.
- [ ] `pnpm typecheck` exits 0.
- [ ] `pnpm lint` exits 0 with 0 errors.
- [ ] `pnpm build` exits 0.
- [ ] `grep -rn "apiAuthHeader" ui/src` matches exactly `ui/src/lib/api-auth.ts`,
      `ui/src/lib/api.ts`, `ui/src/lib/sse.ts`, `ui/src/hooks/use-offline.ts`.
- [ ] `grep -rn "fetch(" ui/src/lib/sse.ts ui/src/hooks/use-offline.ts ui/src/lib/api.ts`
      shows no `/api` fetch without an `apiAuthHeader` call in the same function.
- [ ] `grep -rn "console\." ui/src/lib/api-auth.ts ui/src/stores/auth.store.ts ui/src/components/token-gate.tsx`
      returns no matches (the token must never reach a log).
- [ ] `grep -n "Known gap" README.md` returns no matches.
- [ ] `git status` shows no modified file outside the in-scope list; no `.env`
      file was created; no token value appears in the diff
      (`git diff | grep -i "bearer [A-Za-z0-9]"` → only the code template
      `Bearer ${trimmed}`).
- [ ] `plans/README.md` row 023 updated, and row 004's status corrected to DONE
      (its step 3 is what this plan delivers).

## STOP conditions

Stop and report back if:

- The excerpts in "Current state" do not match the live code.
- You find a fifth browser → API transport that cannot carry a header — an
  `EventSource`, an `<img src="/api/…">`, an `<a href="/api/…" download>`, or an
  `<iframe src="/api/…">`. Header transport cannot cover those, and the fix
  (signed one-time URL or cookie + CSRF) is a design decision outside this plan.
  `grep -rn "EventSource\|src=\"/api\|href=\"/api" ui/src` before you conclude.
- You conclude a cookie, a login endpoint, or any `src/` change is required.
- A verification command fails twice after a reasonable fix attempt.
- `pnpm test` shows a failure in a file you did not touch (that means test
  isolation broke — report the file order, do not "fix" the other test).

## Maintenance notes

- **The load-bearing invariant**: every browser → `/api` request goes through
  JavaScript `fetch`. That is the only reason a request header suffices. Anyone
  later adding an `EventSource`, a direct `<img src="/api/…">`, an `<iframe>`, or
  an anchor download to an API URL silently reintroduces the 401 — such requests
  must be routed through `fetch` + `apiAuthHeader` and turned into a blob URL, as
  `OfflineImage`/`getOfflineImage` already do. `ui/src/lib/utils.ts:69`
  (`proxyUrl`) is currently unreferenced and is exactly the shape of that trap.
- Adding Workbox `runtimeCaching` for `/api` in `ui/vite.config.ts` would cache
  authorized responses in the Cache Storage of a shared browser profile. Decide
  that deliberately, not incidentally.
- A reviewer should scrutinize: that the cross-origin guard in `isApiRequest` is
  used by every call site (not bypassed with a hand-rolled `startsWith`), that
  the token appears in no `console` call, toast, or error message, and that the
  401 branch in `fetchBook` precedes the 304 branch.
- Deferred deliberately: no in-app "change/forget token" control (the 401 path
  makes one unnecessary), and no per-user credentials — `API_TOKEN` remains a
  single shared deployment secret, per plan 004's out-of-scope list.
