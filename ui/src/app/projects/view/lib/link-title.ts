/**
 * Catalog rows often put the chapter title and its age inside the same anchor —
 * Webnovel renders `Characters (Updated for Vol. 15)7 years ago` — so the link's
 * own text carries a trailing relative timestamp that has no business becoming a
 * chapter title.
 *
 * Kept in its own dependency-free module so the root bun test suite can import it
 * by relative path.
 */
const TIME_AGO =
  "(?:\\d+\\s*(?:years?|months?|weeks?|days?|hours?|minutes?|mins?|seconds?|secs?)\\s+ago|just\\s+now)";

/** `(1 month ago)`, `[3 days ago]` — the timestamp is the whole bracket. */
const BRACKETED_TIME = new RegExp(`\\s*[([{]\\s*${TIME_AGO}\\s*[)\\]}]$`, "i");

/** `Title 3 days ago`, `Title - 3 days ago`. */
const TRAILING_TIME = new RegExp(`\\s*[-–—,:;]?\\s*${TIME_AGO}$`, "i");

/** Separators left dangling once the timestamp is gone. */
const TRAILING_SEPARATOR = /[\s–—,;:.\-]+$/;

export function cleanLinkTitle(raw: string) {
  let title = raw.replace(/\s+/g, " ").trim();

  // Rows can stack metadata, so keep stripping while the tail still looks like
  // a timestamp.
  for (let changed = true; changed; ) {
    changed = false;

    for (const pattern of [BRACKETED_TIME, TRAILING_TIME]) {
      if (pattern.test(title)) {
        title = title.replace(pattern, "").replace(TRAILING_SEPARATOR, "").trim();
        changed = true;
      }
    }
  }

  return title.replace(TRAILING_SEPARATOR, "").trim();
}
