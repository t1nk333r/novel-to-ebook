# Plan 029: Companion browser extension

> **Executor instructions**: This is a *build* plan for a new component, written
> from a one-line operator idea ("a companion extension"). Step 0 settles the two
> assumptions the design rests on before any code is written. Nothing here
> changes the server's behaviour, so the existing app cannot regress — but read
> "Security" before choosing where the token lives.

## Status

- **Priority**: P2
- **Effort**: M (v0.1)
- **Risk**: LOW — additive component; no server behaviour changes
- **Depends on**: `plans/023-ui-token-transport.md` (token semantics), `plans/027-scroll-import.md`, `plans/028-whole-book-walk.md`
- **Category**: direction
- **Planned at**: commit `d379afc`, 2026-09-12
- **Implemented**: v0.1 built 2026-09-12 — see "Outcome" below

## Why this matters

Every import path today runs the server's own headless Chromium: one page load per
chapter-page (~3.6 s per chapter through the link importer, ~13 chapters per ~20 s
through the scroll reader), and sites that fingerprint headless browsers have to
be talked past with stealth and an ad blocker. Two consequences:

1. **Sites that block automation are unsupported**, and the workaround is luck.
2. **The user's browser already has the page.** They are looking at the chapter
   they want; the server then loads that same page again, separately, slower, and
   with a worse chance of succeeding.

A companion extension inverts that: the page is captured where it is already
rendered, authenticated with the user's own session, and posted to the API. The
same mechanism gives a **real element picker** — hover-and-click in the live DOM,
instead of the in-app picker's screenshot-plus-coordinate-space approach.

## What already exists (this is why v0.1 is small)

- `POST /api/projects/{projectId}/chapters` takes `{ title, content, index }` and
  inserts at the next index (`chapters/routes.ts`, `insertChapterAtNextIndex`).
  **The extension needs no new server route to send a chapter.**
- `POST /api/projects/{projectId}/chapters/import-scroll` and `.../import-book`
  (§027, §028) cover the URL-based flows, including a resumable whole-book walk.
- Bearer auth (§023): the API expects `Authorization: Bearer <API_TOKEN>` and
  answers 401 `UNAUTHORIZED` without it.
- `GET /api/projects` lists projects, so the options page can offer a picker.
- Limits that matter: `MAX_REQUEST_BODY_BYTES` (1 MB) and `MAX_TEXT_LENGTH`
  (500 KB) — a chapter is 10–70 KB, so a captured chapter fits with room to spare.

## Shape of v0.1

A Manifest V3 extension in `extension/` in this repo (plain ES modules, no build
step, no dependencies — a second build system for 300 lines would be worse than
the code), with:

1. **Options page** — server URL, API token, project. Token goes in
   `chrome.storage.local`; the project list comes from `GET /api/projects` so a
   typo cannot silently target the wrong book.
2. **Two buttons, page context**:
   - *Send chapter* — captures the page's content element and posts it. Uses a
     per-host selector learned from the picker, with a heuristic first guess.
   - *Import book* — on a catalogue page, posts to `/chapters/import-book` and
     reports the queue's progress (the server does the walking).
3. **Element picker** — hover highlights, click selects, and the selector is
   stored per host in `chrome.storage.sync`. This is the piece the in-app picker
   cannot do well: it runs in the real DOM, so the selector is exact and the
   coordinates are the page's own.
4. **Handoff to the server, not a second implementation**: anything involving
   many chapters, ordering, dedupe or the ledger stays on the server. The
   extension captures and posts; it never keeps its own queue.

## Outcome (v0.1, 2026-09-12)

Built and verified as scoped, with one design change and one addition.

**Step 0, both answers measured:**
1. **The worker's cross-origin fetch needs no CORS** — proven in a real Chromium
   with the extension loaded: the popup listed projects from a server that sends
   no `Access-Control-Allow-*` headers. A content-script fetch would have been
   blocked; the service worker's is not. `tests/extension.test.ts` keeps this
   pinned.
2. **`index` is cosmetic** on the create route —
   `insertChapterAtNextIndex(projectId, {title, content})` allocates its own index,
   so a client may post anything.

**One correction to this plan's own claim of "no new server route".** The existing
create route does **no sanitising** — the web editor sends clean HTML, a captured
page does not. Posting a page's `outerHTML` there would have put `<script>`, ad
markup and navigation into the chapter, and from there into the exported EPUB. So
`POST /projects/{id}/chapters/capture` was added: it runs the same
`stripSiteChrome` + `cleanHTML` pipeline as the importers before storing, and
cleans a trailing relative timestamp out of the title.

**What landed**: `extension/` (manifest, service worker, page-side capture and
picker, popup, README) and that one server route. No CORS relaxation, no change to
auth or limits, and the app's own gates are untouched by the extension.

**Evidence**
- Live, against a real server and the real Webnovel chapter, with **no
  server-side browser involved**: the popup listed a real project, captured the
  page, and reported `Added: Chapter 1: The Beginning of the End. Part 1/2`. The
  stored chapter is 1,257 words of prose with no `<script>`, no author note
  (`m-thou`) and no comment widget — byte-for-byte the same cleaning result as the
  server-side scroll import of that chapter.
- The capture route against a deliberately dirty payload: scripts, `m-thou`,
  `user-links-wrap` and a `7 years ago` title suffix all removed, prose kept.
- `tests/extension.test.ts` (browser-gated): loads the extension, proves the
  worker fetch, drives the popup's capture against a local fixture, and asserts
  the posted payload keeps the site's junk (cleaning is the server's job).
- Diagnostics measured the pipeline end to end on the real page: 20,486 bytes
  captured → 30 chrome blocks removed → 7,866 bytes of clean chapter.

**Recorded during the build**
- Reading a page uses the `activeTab` grant that clicking the toolbar icon
  provides. Injected-script failures are why the popup now wraps every handler and
  reports the error, instead of leaving its status stuck on the last message.
- A token is optional: a loopback server enforces none, and a server that does
  require one answers 401, which is better feedback than refusing to try.
- Switching tabs clears the selector field for that host (per-site selectors) —
  correct behaviour, and the reason the send action falls back to the heuristic
  guess when the field is empty.

## Step 0: Settle two assumptions before writing code

1. **Cross-origin fetch without CORS.** MV3 service workers may fetch hosts in
   `host_permissions` without CORS headers, where content scripts may not. Prove
   it against a running server (loopback is enough) with a `host_permissions`
   entry for that origin, then record the result here. If it turns out to need
   CORS, the server gains an allow-listed origin (never `*` with credentials) and
   that is a deliberate, separate change.
2. **`index` is cosmetic on the create route.** Confirm `insertChapterAtNextIndex`
   ignores the posted `index` and allocates its own; if it does not, the extension
   must read the chapter list first, and that changes the design (and would be
   worth fixing server-side instead).

**Verify**: both answers written into this plan, with the command that produced
them.

## Security

- **The token lives in the service worker, never in page context.** A content
  script runs beside the page; anything it holds is one bug away from the page.
  Requests are therefore made by the background worker, which needs
  `host_permissions` for the server origin only.
- **`host_permissions` is the server's origin, not `<all_urls>`.** The extension
  only needs to read the page the user is on, which is the `activeTab` grant.
- **The API stays bearer-only.** No cookies, so no CSRF surface; the extension
  does not change that.
- **No secrets in the extension bundle or its store listing.** Load-unpacked for
  personal use; store publication is explicitly out of scope.
- **Capture is user-initiated.** No background crawling of sites the user is not
  looking at.

## Non-goals (v0.1)

- Firefox/Safari packaging, store publication, auto-update.
- Replacing the in-app picker; both pickers read the same selector shape and the
  in-app one stays the fallback for pages the extension cannot touch.
- Any server-side behaviour change: no new endpoints, no CORS relaxation, no
  change to auth or limits.
- Auto-following "next chapter" links: that is the server's walk (§028).

## Open questions for the operator

1. **Repo or separate?** In-repo (`extension/`, excluded from `pnpm check`) keeps
   it next to the API it targets; a separate repo keeps the app's build untouched.
2. **Capture shape**: post the *rendered text/HTML* (works on sites that block
   automation) or post the *URL* and let the server fetch it (keeps the extension
   trivial, keeps ordering and dedupe server-side, but loses the main advantage)?
   v0.1 assumes the former, with the latter as a fallback button.
3. **Should the extension see the ledger?** Resuming a book from the extension
   would need `GET /projects/{id}` (which already returns `config`), so this is
   possible without new API surface — but it exposes import state to a second
   client, which is a product decision.

## Maintenance notes

- The selector the picker produces must stay compatible with the server's
  `contentSelectorList` (one selector or a list, bounded by `MAX_CONTENT_SELECTORS`),
  or imports will fail validation.
- If the extension later sends many chapters, it must not become a second import
  queue: order, dedupe and the ledger belong to the server.
- A reviewer should confirm the token is never written into `chrome.storage.sync`
  (which syncs across devices) — only `local`.
