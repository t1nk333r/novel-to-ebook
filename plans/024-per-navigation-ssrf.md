# Plan 024: Validate every Chromium navigation, not just the entry URL

> **Executor instructions**: This is a security plan with a hard trade-off in it.
> Read the whole file, then reproduce the gap cheaply before writing any
> interception code — the reproduction is what tells you which of the two
> approaches is justified. If the reproduction is not possible in this
> environment, stop and report rather than implementing blind.
>
> **Drift check**: `git diff --stat 04dfe0e..HEAD -- src/lib/network-policy.ts src/lib/browser.ts src/app/projects/routes.ts src/app/projects/utils.ts src/app/library`

## Status

- **Priority**: P1
- **Effort**: M–L
- **Risk**: MED–HIGH
- **Depends on**: `plans/005-safe-outbound-urls.md` (landed)
- **Category**: security
- **Planned at**: commit `04dfe0e`, 2026-09-12
- **Resolved**: 2026-09-12 — navigation interception (option 1), see below

## Resolution 2026-09-12

**Reproduced end to end before writing any code.** A throwaway script stood up a
loopback "internal service" returning `INTERNAL-SECRET-MARKER`, and pointed
Chromium at `https://httpbin.org/redirect-to?url=http://127.0.0.1:3015/` — a
public URL the entry-URL guard approves:

```
WITHOUT guard: finalUrl "http://127.0.0.1:3015/"   markerVisible true
WITH guard:    finalUrl "chrome-error://chromewebdata/"
               blocked: http://127.0.0.1:3015/ :: net::ERR_BLOCKED_BY_CLIENT
```

So the plan's predicted exposure was real: an approved page redirects the browser
into loopback and the internal document is rendered — the same HTML the snapshot
route returns and the import worker persists.

**Mechanism: option 1 (navigation interception), because the alternative was
measurably unavailable.** Two interception layers already exist in this app —
the Ghostery ad blocker calls `page.setRequestInterception(true)` and registers
`page.on('request')` — so the plan's warning about conflicting layers was the
real risk. Reading that dependency settled it: its handler starts with
`if (details.isInterceptResolutionHandled?.()) return;` and continues top-level
documents at **priority 0**, i.e. it participates in Puppeteer's cooperative
interception. A guard that aborts disallowed documents at a higher priority
therefore overrides it without a second interception layer, and its own handler
continues everything else at priority −1 so the blocker's decisions still win.

The probe confirmed coexistence rather than assuming it: no "Request is already
handled" console noise, and `example.com` still rendered with both active.

What landed: `guardNavigations(page, { isAllowed? })` in `src/lib/browser.ts`,
applied inside `newBrowserPage()` so no call site — present or future — can skip
it (the plan asked for the three call sites; this covers them and closes the door
behind them). `isAllowed` is injectable so the regression test can prove both
outcomes against one loopback fixture without the public internet.

Verified after: the redirect into loopback is refused at the route level
(`POST /projects/extract` → 400, no internal content), snapshots still stream
screenshots and a `result` event, and extraction with a selector returns the
page's blocks. The bare-extract failure on `example.com` is pre-existing — the
deployed pre-change build fails it identically, because the page is under the
auto-detect length threshold.

**One live defect found and fixed while testing:** the ad blocker loads its
filter lists from a CDN, and during this session that CDN returned HTML, so
`fromPrebuiltAdsAndTracking` threw — inside `getBrowser()`, which meant *every*
browser-driven feature failed. It is now best-effort: on failure it logs and
continues without ad blocking.

## Why this matters

Storvi's security model rests on one policy: every outbound request from the
server goes through `assertSafeOutboundUrl` / `safeFetch` in
`src/lib/network-policy.ts`, which rejects non-http(s) schemes, credentials in
the URL, loopback, private ranges and link-local addresses (including the cloud
metadata endpoint), re-checks every redirect hop, and caps the response size.

Puppeteer is the one client that policy does not cover. All three browser call
sites check the **entry URL** and then hand Chromium an unrestricted network
stack:

```ts
await assertSafeOutboundUrl(url);            // one hostname, resolved by Node
await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
```

Chromium resolves that hostname independently, follows redirects itself, and
loads every subresource — images, fonts, stylesheets, iframes, XHR — with no
check at all. Consequences for a self-hosted single-operator app whose whole
purpose is to fetch pages an operator does not control:

- `https://attacker.example/x` answering `302 Location: http://169.254.169.254/…`
  gets the metadata document rendered, and the snapshot SSE returns that HTML
  (`contentSelector`, `html`) while the import worker persists it as chapter
  content with `insertChapterAtNextIndex`.
- The same gap is the classic DNS-rebinding window: the guard resolves once, the
  browser resolves again later.

This is not a remote unauthenticated attack — the caller must already hold the
API token, and pointing the picker at an attacker-influenced page is the normal
workflow. The exposure is that untrusted *page content* can steer a privileged
network client inside the operator's network.

## Current state

- `src/lib/network-policy.ts` — `isPublicIp(address)` (sync, exported),
  `assertSafeOutboundUrl(input, { lookup? })`, `safeFetch(input, init?, { lookup?,
  maxRedirects?, timeoutMs? })`, `readResponseBytes(response, maximum?)`. This
  module is the policy; it is correct and well covered by
  `tests/security-boundaries.test.ts`. Do not rewrite it.
- `src/app/projects/routes.ts` — `POST /projects/snapshot`: page created, then
  `assertSafeOutboundUrl(url)`, then `page.goto` (inside the SSE stream).
- `src/app/projects/utils.ts` — `tryExtractContent` and `extractContent` do the
  same `assertSafeOutboundUrl` + `page.goto` pair. The first is the live path
  (`POST /projects/extract` and the chapter import worker).
- `src/lib/browser.ts` — `getBrowser()` (launch options, currently no
  `--proxy-server`) and `newBrowserPage()`. Every page in the app comes from
  here, which makes it the natural place for a shared interception helper.
- Fetch-based outbound paths were brought under the policy in `04dfe0e`
  (`decryptTextFromFont`); export-time image URLs are still unguarded — that is
  `plans/026`.

## Commands you will need

```bash
export PATH="$HOME/.local/share/mise/installs/bun/1.4.0/bin:$PATH"
pnpm install --frozen-lockfile --ignore-scripts
```

| Purpose | Command | Expected |
|---|---|---|
| Unit tests | `pnpm test` | all pass |
| One file | `bun test tests/security-boundaries.test.ts` | all pass |
| Typecheck / lint / build | `pnpm typecheck`, `pnpm lint`, `pnpm build` | 0 errors |
| Manual server | `HOST=127.0.0.1 PORT=3012 DATABASE_URL=/tmp/ssrf.sqlite bun run src/index.ts` | `Listening on` |

Chromium is at `/usr/bin/chromium` on this machine; puppeteer picks it up with
`PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium`.

## Scope

**In scope**: `src/lib/browser.ts` (a shared page/navigation helper),
`src/app/projects/routes.ts` and `src/app/projects/utils.ts` (call sites),
`tests/` (a regression test for whatever mechanism you land), and a paragraph in
the README security section describing the residual risk.

**Out of scope**: `src/lib/network-policy.ts` semantics; `safeFetch` call sites;
the export-time image URLs (plan 026); a general egress proxy for the whole host.

## Steps

### Step 1: Reproduce the gap, cheaply and locally

Do not point the test at a real metadata service. Prove the *mechanism* instead,
with a redirect the policy would reject if it saw it:

1. Start the server on a loopback port and confirm the guard rejects a direct
   call: `curl -s -X POST -H 'Content-Type: application/json' -d '{"url":"http://127.0.0.1:3012/"}' http://127.0.0.1:3012/api/projects/snapshot` → the policy's 400.
2. Now place a redirect *in front of* that loopback address. A public redirector
   is unreliable; instead check whether the entry-URL check can be satisfied by
   a name that resolves publicly at check time and privately for Chromium — if
   you cannot do that here, an acceptable substitute is to read the code and
   show, with `page.on("response")` in a throwaway script, that Chromium follows
   a cross-origin redirect issued by a page the guard approved.

Record exactly what you ran and what you observed. **If neither form of
reproduction works in this environment, stop and report** — do not implement
interception on a theoretical basis alone.

**Verify**: a reproduction transcript, or a clear statement that it could not be
reproduced and why.

### Step 2: Choose the mechanism

Two candidate designs. Prefer the first; take the second only if the first
measurably breaks real pages.

1. **Navigation interception (narrow).** Use `page.setRequestInterception(true)`
   or CDP `Fetch.enable` on a shared helper in `src/lib/browser.ts`, and apply
   the policy to **navigation requests only** (`request.isNavigationRequest()`),
   allowing subresources through as today. This closes the redirect and
   rebinding path for the document itself, which is what gets persisted as
   chapter content, at much lower risk to page fidelity than filtering every
   subresource. Reuse `assertSafeOutboundUrl` per navigation, and cache
   resolutions per host for the lifetime of the page so a page with many
   navigations does not re-resolve constantly.
2. **Policy proxy.** Run Chromium with `--proxy-server` pointing at a local
   policy-enforcing proxy. Strongest coverage (subresources included), largest
   blast radius, and it needs lifecycle management for the proxy process.

Whichever you pick, the existing per-call `assertSafeOutboundUrl` stays — it is
the fast, clear early rejection.

**Verify**: a one-paragraph decision with the evidence from step 1, written into
your report.

### Step 3: Implement

Wire the helper into all three call sites so no future browser code can bypass
it: the snapshot route, `tryExtractContent`, and `extractContent`. A blocked
navigation must fail the same way the policy does today (a 400 with the policy's
error for the request-driven paths; the existing SSE `error` event for the
snapshot stream) — not a hung page.

**Verify**: `pnpm typecheck` → exit 0, and your step-1 reproduction now fails
closed (the navigation is refused, and no internal content is returned).

### Step 4: Regression test

Add a test that would fail if interception is removed. It must not need the
public internet: drive the helper directly with a stub or a loopback-only
fixture, asserting that a navigation to a private address is refused while a
public one is allowed. If a browser is required, keep it in its own file and
skip it when `PUPPETEER_EXECUTABLE_PATH` is unset, and say so in the plan status
when you finish.

**Verify**: `pnpm test` → all pass, including the new test; and the new test
fails if you temporarily comment out the interception.

### Step 5: Document the residual risk

Add a short paragraph to the README's security/configuration section: the
document navigation is policy-checked; subresources are not (or are, if you took
the proxy approach); the browser is reachable only by a token holder.

**Verify**: `grep -n "subresource" README.md` returns the new paragraph.

## Done criteria

- [ ] The reproduction from step 1 is recorded (or its impossibility is).
- [ ] All three browser entry points share one navigation-checking path.
- [ ] A regression test exists and fails when the check is removed.
- [ ] `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build` clean.
- [ ] README documents what is and is not policed.
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report if:

- The gap cannot be reproduced in this environment (step 1) — a plan built on
  an unreproduced mechanism is how the plans in this repo previously went wrong.
- Interception measurably breaks real pages (snapshots timing out, the picker
  returning an empty element tree) — that is a product-level trade-off decision.
- You find yourself editing `src/lib/network-policy.ts` to make interception
  easier: its semantics are load-bearing for the fetch paths and are not the
  problem here.

## Maintenance notes

- Any new Puppeteer call site must go through the shared helper; `newBrowserPage`
  already centralises page creation, which is the cheapest place to enforce it.
- Request interception changes page timing. If snapshots start failing on real
  news sites after this lands, the likely cause is interception overhead or a
  blocked navigation that used to work — check the guard's DNS handling before
  loosening the policy.
