# 030 — A chrome match must never delete the content block

- **Status**: DONE (2026-09-12)
- **Severity**: high — silent empty chapters on any path that selects the chapter's own container
- **Found while**: verifying plan 029's element picker against the live site

## The defect

`stripSiteChrome` removes site furniture by matching class/id tokens against
`CHROME_PATTERNS`. Webnovel tags its chapter container with
`para-comment-allowed` — it is there to enable per-paragraph comment threads — and
that token matches the `comments?` pattern. The result:

```
<div class="chapter_content j_chapter_31586142793028464 para-comment-allowed">   ← removed
  <div class="cha-words">  … 1,277 words of prose …  </div>
</div>
```

Measured on the live chapter: 23,910 bytes captured → 32 blocks removed → **49 words
of promo markup left**, and the route answers `400 Nothing usable left after
cleaning the capture`. Nothing logs a warning; the content simply disappears.

## Why it was reachable

Every selector used so far sat *below* the container (`div.cha-content`,
`div.cha-words`), so the bug stayed hidden. It is reachable by:

- the plan 029 picker, whose content-block rule climbs from the clicked paragraph
  to the outermost wrapper that is still content — the container level exactly, and
- the server-side snapshot picker (plans 020/021), where a user clicking the
  chapter's outer box gets `div.chapter_content` or `#page`.

So it is not an extension bug: any user of the existing picker could have had a
chapter silently emptied, and the only signal was a 400 whose text says "nothing
usable left" as if the page had been empty.

## The fix

A matching block that holds most of the capture is the content, not furniture.
`stripSiteChrome` counts the fragment's words once, then keeps any matching
element that holds `≥ 40` words **and** `≥ 50%` of them:

```ts
const majority = Math.max(CONTENT_SIZE_FLOOR, totalWords * 0.5);
if (words(element) >= majority) return;   // this is the content, not chrome
```

The floor matters: without it, a capture consisting only of an author's note would
"rescue" that note as content instead of cleaning to empty, which is what
`tests/content-chrome.test.ts` pins ("can empty content entirely when every block
is furniture").

Measured before/after on the live chapter, same page load, `#page` level:

| | captured | cleaned |
|---|---|---|
| before | 23,910 b | 1,280 w |
| after the picker ran, before the fix | 32,793 b | **49 w** |
| after the picker ran, with the fix | 33,067 b | **1,322 w** |

## Evidence

- `tests/content-chrome.test.ts` — "keeps the chapter when its own container
  matches a chrome pattern". Reverting the guard fails it with
  `Received: "<html><head></head><body></body></html>"`, i.e. the whole chapter
  deleted, which is the production symptom exactly.
- Live, on the real chapter: `div.cha-words`, `div.cha-content`,
  `div.cha-page-in` and `#page` all clean to 1,257–1,322 words; before the fix the
  container levels cleaned to 49.
- Full suite 154 tests, twice, plus the browser-gated files.

## Follow-ups this suggests (not done)

`CHROME_PATTERNS` will keep colliding with site naming: `para-comment-allowed` is
a plausible token for any site that enables inline comments on prose. The guard
makes collisions non-fatal, which is the right default, but a *token-level*
allowlist (only match tokens that are exactly the word, or that the site's markup
places outside the content) would be more precise. Left alone deliberately: the
guard covers the failure mode, and the pattern list is documented as
site-specific and editable.
