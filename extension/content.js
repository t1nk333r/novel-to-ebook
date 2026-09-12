/**
 * Page-side functions, injected with `chrome.scripting.executeScript({ func })`.
 *
 * Each one is serialized and evaluated in the page, so — exactly like the
 * server's `extractElements`/`getCleanHTML` — it must reference nothing from
 * module scope. Everything it needs is declared inside it.
 *
 * This is why the extension exists: the page is already rendered in the user's
 * own browser, logged in, past whatever bot check the site runs, so capture costs
 * nothing and cannot be fingerprinted as automation.
 */

/**
 * Hover to highlight, click to choose. Resolves to a CSS selector, or null when
 * the user presses Escape.
 */
export function pickContentSelector() {
  return new Promise((resolve) => {
    const box = document.createElement("div");
    box.style.cssText =
      "position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #00e5ff;background:rgba(0,229,255,0.12);transition:all 60ms linear";
    const label = document.createElement("div");
    label.style.cssText =
      "position:fixed;z-index:2147483647;pointer-events:none;background:#00e5ff;color:#000;font:11px/1.6 monospace;padding:0 4px;border-radius:2px";
    document.documentElement.append(box, label);

    /** Shortest selector that resolves to exactly this element. */
    const selectorFor = (element) => {
      const esc = (value) => (window.CSS?.escape ? CSS.escape(value) : value);
      const unique = (selector) =>
        document.querySelectorAll(selector).length === 1;

      if (element.id && unique("#" + esc(element.id))) return "#" + esc(element.id);

      const parts = [];
      let node = element;
      while (node && node.nodeType === 1 && node !== document.documentElement) {
        const tag = node.tagName.toLowerCase();

        if (node.id && unique("#" + esc(node.id))) {
          parts.unshift("#" + esc(node.id));
          break;
        }

        const classes = (node.getAttribute("class") || "")
          .trim()
          .split(/\s+/)
          .filter((name) => name && !/^[a-z]*_?[0-9a-f]{6,}$/i.test(name))
          .slice(0, 2);
        const sameTag = Array.from(node.parentElement?.children ?? []).filter(
          (sibling) => sibling.tagName === node.tagName,
        );
        const position = sameTag.indexOf(node) + 1;

        let part = tag + classes.map((name) => "." + esc(name)).join("");
        if (sameTag.length > 1) part += `:nth-of-type(${position})`;

        parts.unshift(part);
        node = node.parentElement;
      }

      if (parts.length === 0) return element.tagName.toLowerCase();

      // Prefer the shortest tail that is still unique.
      for (let index = 0; index < parts.length; index++) {
        const candidate = parts.slice(index).join(" > ");
        if (unique(candidate)) return candidate;
      }

      return parts.join(" > ");
    };

    /**
     * What a click means: the content block, not the element under the cursor.
     * Clicking a paragraph in the middle of a chapter must not capture that one
     * paragraph, so climb to the outermost wrapper that is still content.
     *
     * Share-of-parent is the wrong test — a paragraph is legitimately 2.5% of its
     * 1257-word chapter. What actually separates content from shell, measured on
     * a real chapter, is chrome: `.cha-words` → `.cha-page-in` contain no
     * nav/aside/form/button (the climb's target) while `.cha-page` above them
     * contains 67. Link density catches link lists the same way.
     */
    const contentBlockFrom = (start) => {
      const chrome = "nav, aside, form, button, input, select, iframe";
      const words = (element) =>
        (element?.textContent || "").trim().split(/\s+/).filter(Boolean).length;
      const linkWords = (element) =>
        Array.from(element.querySelectorAll("a")).reduce(
          (sum, anchor) => sum + words(anchor),
          0,
        );

      let best = start;
      let node = start.parentElement;

      while (node && node !== document.body && node !== document.documentElement) {
        const own = words(node);

        // Only meaningful for block-sized nodes: a short paragraph carrying a
        // couple of glossary links is content, not navigation.
        if (own >= 60 && linkWords(node) / own > 0.25) break;
        if (node.querySelectorAll(chrome).length > 2) break;
        // The first climb is the big one (paragraph → whole chapter: 32 → 1257
        // words on Webnovel). After that, text should grow gently; a multiple is
        // a sidebar being absorbed.
        if (best !== start && words(best) >= 200 && own > words(best) * 3) break;

        best = node;
        node = node.parentElement;
      }

      return best;
    };

    const outline = (element, hint) => {
      const rect = element.getBoundingClientRect();
      box.style.left = `${rect.left}px`;
      box.style.top = `${rect.top}px`;
      box.style.width = `${rect.width}px`;
      box.style.height = `${rect.height}px`;
      label.style.left = `${rect.left}px`;
      label.style.top = `${Math.max(0, rect.top - 18)}px`;
      label.textContent = `${selectorFor(element).slice(0, 80)}${hint}`;
    };

    const onMove = (event) => {
      const target = event.target;
      if (target && target.nodeType === 1) {
        outline(contentBlockFrom(target), event.shiftKey ? " (this element)" : "");
      }
    };

    const finish = (value) => {
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKey, true);
      box.remove();
      label.remove();
      resolve(value);
    };

    const onClick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      const target = event.target;
      if (!target || target.nodeType !== 1) return finish(null);

      finish(selectorFor(event.shiftKey ? target : contentBlockFrom(target)));
    };

    const onKey = (event) => {
      if (event.key === "Escape") finish(null);
    };

    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey, true);
  });
}

/**
 * Capture a chapter's markup and a title for it. Returns `{ title, html, url }`.
 */
export function captureChapter(selector) {
  if (!selector || !selector.trim()) return { error: "No selector was picked" };

  const element = document.querySelector(selector);
  if (!element) return { error: `Nothing matches ${selector} on this page` };

  const clean = (value) => (value || "").replace(/\s+/g, " ").trim();

  // The title is the nearest heading before the content, or one inside it — the
  // same rule the server uses for catalogue rows.
  const headings = Array.from(document.querySelectorAll("h1, h2, h3")).filter(
    (node) => clean(node.textContent).length > 0,
  );
  let title = "";
  for (const heading of headings) {
    const position = element.compareDocumentPosition(heading);
    if (position & Node.DOCUMENT_POSITION_PRECEDING) {
      title = clean(heading.textContent);
    } else if (position & Node.DOCUMENT_POSITION_CONTAINED_BY) {
      break;
    }
  }
  if (!title) {
    const inside = element.querySelector("h1, h2, h3");
    title = clean(inside?.textContent);
  }
  if (!title) title = clean(document.title);

  return { title, html: element.outerHTML, url: location.href };
}

/** First guess, used until the user picks: the biggest text block that fits. */
export function guessContentSelector() {
  const candidates = Array.from(
    document.querySelectorAll("article, main, .chapter, [class*='chapter'], [id*='chapter'], [class*='content'], [class*='read']"),
  );

  let best = null;
  let bestScore = 0;

  for (const element of candidates) {
    const text = (element.textContent || "").trim();
    const words = text ? text.split(/\s+/).length : 0;
    if (words < 120) continue;

    // Prefer the innermost element that still holds most of the text.
    const parentText = (element.parentElement?.textContent || "").trim();
    const share = words / Math.max(1, parentText.split(/\s+/).length);
    const score = words * share;

    if (score > bestScore) {
      bestScore = score;
      best = element;
    }
  }

  if (!best) return null;

  if (best.id) return "#" + CSS.escape(best.id);
  const className = (best.getAttribute("class") || "").trim().split(/\s+/)[0];
  return className ? `${best.tagName.toLowerCase()}.${CSS.escape(className)}` : best.tagName.toLowerCase();
}
