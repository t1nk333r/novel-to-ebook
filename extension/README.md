# Storvi capture (browser extension)

Send the chapter you are reading to your Storvi library, from the browser that
already has it open.

## Why this exists

Every other import path drives the **server's own headless Chromium**: it loads
the page again, slower, and sites that fingerprint automation have to be talked
past with stealth and an ad blocker. The extension inverts that. The page is
already rendered in your browser, logged in and past the site's bot check, so
capture is instant and cannot be fingerprinted as automation. The server's
browser is never started.

It also gives a **real element picker**: hover and click in the live DOM, so the
selector is exact.

## Install (unpacked)

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select this `extension/` directory

## Use

1. Click the toolbar icon on a chapter page.
2. First time only: set the **server URL** (e.g. `http://127.0.0.1:3000`) and, if
   your server uses one, the **API token** from its `API_TOKEN`. Save.
   - Loopback servers need no token.
   - A non-loopback server prompts for permission to reach that origin once.
3. **Pick content** — click anywhere in the chapter text. A click picks the
   *content block*, not the exact element: clicking a paragraph selects the
   chapter around it, because a single paragraph would silently truncate the
   chapter to one screen of text. Shift-click takes the exact element under the
   cursor when you want that instead. The selector is remembered per site, so
   later chapters are one click.
4. **Send chapter** — the captured markup goes to the server, which cleans it the
   same way the importers do (scripts, ads, author-note blocks and comment
   widgets removed) and appends it to the chosen project.
5. **Import the whole book** on a catalogue page: runs the server's whole-book
   walk (§028) against that URL, resuming where a previous run stopped.

## How it works

| Piece | Role |
|---|---|
| `background.js` | The only place the token is used. Fetches the API from the service worker, which may reach granted origins without CORS headers. |
| `content.js` | Injected into the page. `pickContentSelector` (hover/click → selector), `captureChapter` (element + title), `guessContentSelector` (first-run fallback). |
| `popup.html` / `popup.js` | Configuration, target tab, project, and the three actions. |

The captured HTML is posted to `POST /api/projects/{id}/chapters/capture`, which
runs `stripSiteChrome` + `cleanHTML` before storing. Sanitising on the server is
deliberate: a captured page carries scripts and navigation that the web editor
never sends, and all of it would otherwise reach the exported book.

## Security

- **The token never enters page context.** Content scripts run beside the page;
  the token stays in the service worker, is stored in `chrome.storage.local`
  (never `sync`, which would replicate it across devices), and is never returned
  to the popup.
- **Host permissions are narrow.** Loopback is granted up front; any other server
  origin is requested at save time. Reading a page uses the `activeTab` grant that
  clicking the toolbar icon provides — no `<all_urls>`.
- **Capture is user-initiated**, per page. Nothing runs in the background.
- The API keeps its bearer-only design: no cookies, so no CSRF surface.

## Notes and limits

- Chromium/Manifest V3 only; Firefox packaging is not attempted.
- A site whose content is split across several elements needs the selector to be
  a CSS union (comma-separated) — the server accepts that. Shift-click is the way
  to narrow a pick that climbed too far.
- The captured markup is cleaned server-side; if a site tags its chapter
  container with something that looks like furniture (Webnovel does:
  `para-comment-allowed`), the server keeps the block rather than deleting the
  chapter — see plan 030.
- The extension does not track progress or dedupe: those live on the server. Send
  the same chapter twice and you get it twice.
- Development: `tests/extension.test.ts` loads this directory into a real
  Chromium and drives the popup against a local API double.
