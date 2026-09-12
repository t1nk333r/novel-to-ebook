import { Page, type Frame } from "puppeteer";
import * as cheerio from "cheerio";
import { cleanHTML } from "../../lib/utils";
import fs from "fs/promises";
import path from "path";
import { assertSafeOutboundUrl, readResponseBytes, safeFetch } from "../../lib/network-policy";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import * as extractus from "@extractus/article-extractor";
import {
  detectObfuscatedContent,
  FontDecryptor,
} from "../../lib/font-decryptor";
import { decryptTextFromFont } from "../utility/utils";
import { HTTPError } from "../../lib/error";
import { limits } from "../../lib/limits";
import db from "../../db";

export function extractElements(ignoreDuplicates = false) {
  const result: any[] = [];
  const seen = new Set();

  const tags = [
    "h1",
    "h2",
    "h3",
    "h4",
    "p",
    "b",
    "strong",
    "em",
    "i",
    "u",
    "a",
    "img",
    "ul",
    "ol",
    "li",
    "table",
    "tr",
    "td",
    "th",
    "div",
    "section",
    "article",
    "header",
    "footer",
    "nav",
    "main",
    "aside",
    "button",
    "input",
    // "form",
    "span",
    "figure",
    "blockquote",
    "select",
  ];

  function getSelector(el: HTMLElement, doc: Document) {
    const parts: string[] = [];
    let current: HTMLElement | null = el;
    let best = "";

    let depth = 0;
    while (current && current !== doc.body && depth < 10) {
      depth++;
      let seg = current.tagName.toLowerCase();
      let stop = false;
      if (current.id) {
        seg += `#${current.id}`;
        stop = true;
      } else {
        const classes = Array.from(current.classList)
          .filter((c) => {
            return !c.match(/^\d/) && c.length < 24 && !c.match(/\d{6,}/);
          })
          .slice(0, 3)
          .join(".");
        if (classes) seg += `.${classes}`;
        const siblings = current.parentElement
          ? Array.from(current.parentElement.children).filter(
              (c) =>
                c.tagName === current?.tagName &&
                (!current.classList.length ||
                  c.classList.contains(current.classList[0]!)),
            )
          : [];
        if (siblings.length > 1) {
          seg += `:nth-of-type(${siblings.indexOf(current) + 1})`;
        }
      }
      parts.unshift(seg);

      const candidate = parts.join(" > ");
      best = candidate;

      try {
        if (
          doc.querySelectorAll(candidate).length === 1 &&
          doc.querySelector(candidate) === el
        ) {
          return candidate;
        }
      } catch {
        // malformed selector (e.g. CSS-special characters in a class name) —
        // treat as non-unique and keep walking
      }

      if (stop) break;
      current = current.parentElement;
    }

    return best;
  }

  for (const tag of tags) {
    document.querySelectorAll(tag).forEach((el: any) => {
      const rect = el.getBoundingClientRect();
      // if (rect.width < 5 || rect.height < 5) return;
      const selector = getSelector(el, document);

      if (ignoreDuplicates) {
        if (seen.has(selector)) return;
        seen.add(selector);
      }

      // exclude if parent tags is not in the list of allowed tags
      // let parent = el.parentElement;
      // let depth = 0;
      // while (parent && parent !== document.body && depth < 3) {
      //   if (!tags.includes(parent.tagName.toLowerCase())) return;
      //   parent = parent.parentElement;
      //   depth += 1;
      // }

      // exclude if element is hidden or not visible
      const style = window.getComputedStyle(el);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        Number(style.opacity) < 0.01
      )
        return;

      const text =
        el.innerText?.trim().slice(0, 80) ||
        el.getAttribute("alt") ||
        el.getAttribute("src") ||
        "";

      result.push({
        tag: el.tagName.toLowerCase(),
        selector,
        text,
        box: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
        },
        attrs: {
          id: el.id || undefined,
          class: el.className?.slice?.(0, 60) || undefined,
          href: el.href || undefined,
          src: el.src || undefined,
        },
      });
    });
  }

  return result;
}

export function getCleanHTML() {
  const tagsToRemove = [
    "script",
    "style",
    "svg",
    "noscript",
    "iframe",
    "video",
    "[role='dialog']",
    "[aria-modal='true']",
    "[tabindex='-1']",
    "[class*='dialog']",
    "[class*='modal']",
  ];
  tagsToRemove.forEach((tag) => {
    document.querySelectorAll(tag).forEach((el) => el.remove());
  });

  const allowedAttributes = [
    "id",
    "class",
    "itemprop",
    "href",
    "src",
    "alt",
    "title",
    "role",
    "rel",
  ];

  // Remove unnecessary attributes
  document.body.querySelectorAll("*").forEach((el) => {
    Array.from(el.attributes).forEach((attr) => {
      if (!allowedAttributes.includes(attr.name)) {
        el.removeAttribute(attr.name);
      }
    });
  });

  return document.body.outerHTML
    .replace(/\s+/g, " ")
    .replace(/>\s+</g, "><")
    .trim();
}

/**
 * A frame's position in the frame tree, as the CSS selector of each <iframe>
 * from the main frame down. Frame *URLs* are deliberately not used: they carry
 * cache-busting query strings that change between loads.
 */
export type FramePath = string[];

/**
 * Describe one `<iframe>` well enough to find it again. Runs inside the parent
 * frame via `evaluate`, so it must not reference module scope (see the
 * CRITICAL CONSTRAINT note on `extractElements`).
 */
const DESCRIBE_IFRAME = (el: Element) => {
  const tag = el.tagName.toLowerCase();
  const parent = el.parentElement;
  if (!parent) return tag;

  const sameTag = Array.from(parent.children).filter(
    (child) => child.tagName === el.tagName,
  );
  return `${tag}:nth-of-type(${sameTag.indexOf(el) + 1})`;
};

function originOf(url: string) {
  try {
    return new URL(url).origin;
  } catch {
    return "(unknown origin)";
  }
}

/** Walk `frame` up to the main frame, collecting one selector per level. */
export async function framePathOf(frame: Frame): Promise<FramePath | null> {
  const segments: string[] = [];
  let current: Frame | null = frame;

  while (current && current.parentFrame()) {
    const handle = await current.frameElement();
    if (!handle) return null;

    const segment = await handle.evaluate(DESCRIBE_IFRAME);
    if (!segment) return null;

    segments.unshift(segment);
    current = current.parentFrame();
  }

  return segments;
}

/**
 * Every element the picker can offer, across the page's frames.
 *
 * The screenshot shows content rendered inside frames, so element enumeration
 * has to see it too — otherwise a page that visibly contains the chapter offers
 * nothing to click. Structure is main-frame-first; each child frame's boxes are
 * translated into main-frame space, which is the coordinate system the UI
 * overlay draws in. `frameElement().boundingBox()` is main-frame-absolute at any
 * depth (verified against a nested fixture), so a single offset per frame is
 * enough — no walking the parent chain.
 *
 * A frame that is detached or navigating is skipped: one bad frame must not
 * fail the whole snapshot.
 */
export async function collectFrameElements(page: Page, ignoreDuplicates: boolean) {
  const main = page.mainFrame();
  const frames = page.frames();

  const usable = frames.slice(0, limits.frames);
  if (frames.length > usable.length) {
    console.warn(
      `snapshot: ${frames.length - usable.length} frames past MAX_FRAMES ignored`,
    );
  }

  const collected: Record<string, unknown>[] = [];

  for (const frame of usable) {
    try {
      const elements = (await frame.evaluate(
        extractElements,
        ignoreDuplicates,
      )) as Record<string, unknown>[];

      if (frame === main) {
        collected.push(...elements.map((el) => ({ ...el, framePath: [] })));
        continue;
      }

      const framePath = await framePathOf(frame);
      if (!framePath) continue;

      const handle = await frame.frameElement();
      const frameBox = await handle?.boundingBox();
      if (!frameBox) continue;

      collected.push(
        ...elements.map((el) => {
          const box = el.box as { x: number; y: number; w: number; h: number };
          return {
            ...el,
            framePath,
            box: {
              x: box.x + frameBox.x,
              y: box.y + frameBox.y,
              w: box.w,
              h: box.h,
            },
          };
        }),
      );
    } catch (err) {
      console.warn(
        `snapshot: skipped frame ${originOf(frame.url())} —`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return collected;
}

/** The frame a selector path points at; empty or absent means the main frame. */
export async function resolveFrame(page: Page, framePath?: FramePath | null) {
  if (!framePath || framePath.length === 0) return page.mainFrame();

  let frame = page.mainFrame();

  for (const segment of framePath) {
    const child = await findChildFrame(frame, segment);
    if (!child) {
      throw new HTTPError(
        `No frame matches selector "${segment}" — the page structure changed, pick the content again`,
        { status: 400, code: "FRAME_NOT_FOUND" },
      );
    }
    frame = child;
  }

  return frame;
}

async function findChildFrame(parent: Frame, segment: string) {
  for (const child of parent.childFrames()) {
    const handle = await child.frameElement();
    if (!handle) continue;

    const matches = await handle.evaluate(
      (el, selector) => el.matches(selector),
      segment,
    );
    if (matches) return child;
  }

  return null;
}

/**
 * Reduce a page to the structure a selector model needs: tags, ids and classes,
 * plus the *length* of each text node as `«142»` — never the text itself, which
 * is what blows a small model's context window. Long runs of sibling elements
 * that share a tag and class collapse to a few examples plus a count, because a
 * chapter list is one repeated pattern rather than a hundred distinct ones.
 *
 * Pure and JSDOM-only, so it is testable without a browser.
 */
export function htmlSkeleton(html: string, maxBytes: number) {
  const dom = new JSDOM(html);
  const { document } = dom.window;

  document
    .querySelectorAll("script, style, svg, noscript, iframe, video")
    .forEach((el) => el.remove());

  const walk = (node: Element | ChildNode): string => {
    if (node.nodeType === 3) {
      const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
      return text.length > 0 ? `«${text.length}»` : "";
    }

    if (node.nodeType !== 1) return "";

    const element = node as Element;
    const tag = element.tagName.toLowerCase();
    const id = element.getAttribute("id");
    const className = element.getAttribute("class");
    const attrs =
      (id ? ` id="${id}"` : "") +
      (className ? ` class="${className.trim().replace(/\s+/g, " ")}"` : "");

    const children = Array.from(element.childNodes);
    const parts: string[] = [];
    let index = 0;

    while (index < children.length) {
      const child = children[index]!;
      const signature = childSignature(child, tag);
      let run = 1;

      if (signature) {
        while (
          index + run < children.length &&
          childSignature(children[index + run]!, tag) === signature
        ) {
          run++;
        }
      }

      const elementChildren = children
        .slice(index, index + run)
        .filter((c) => c.nodeType === 1);

      if (run > 5 && elementChildren.length === run) {
        for (const item of elementChildren.slice(0, 3)) {
          parts.push(walk(item));
        }
        parts.push(`«… ${run - 3} more ${signature}»`);
      } else {
        for (const item of children.slice(index, index + run)) {
          parts.push(walk(item));
        }
      }

      index += run;
    }

    return `<${tag}${attrs}>${parts.join("")}</${tag}>`;
  };

  const body = document.body ?? document.documentElement;
  let skeleton = walk(body);

  if (skeleton.length > maxBytes) {
    const cut = skeleton.lastIndexOf(">", maxBytes);
    skeleton = `${skeleton.slice(0, cut > 0 ? cut + 1 : maxBytes)}«truncated»`;
  }

  return skeleton;
}

/** Tag + class of a child, or null when it cannot start a collapsible run. */
function childSignature(node: ChildNode, parentTag: string) {
  if (node.nodeType !== 1) return null;

  const tag = (node as Element).tagName.toLowerCase();
  // A nested same-tag element would make a run ambiguous to collapse.
  if (tag === parentTag) return null;

  const className = (node as Element).getAttribute("class")?.trim();
  return className
    ? `${tag}.${className.split(/\s+/).join(".")}`
    : tag;
}

export async function extractContent(page: Page, url: string, selectors: any) {
  await assertSafeOutboundUrl(url);
  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });

  const html = await page.evaluate(() => {
    return document.body.outerHTML.trim();
  });
  const $ = cheerio.load(html);
  const chapter = selectors.chapter
    ? $(selectors.chapter)
        .filter((_, i) => $(i).text().trim().length > 0)
        .first()
        .text()
        .trim()
    : null;
  const content = cleanHTML($(selectors.content).html() || "").replace(
    /src="\/\//g,
    'src="https://',
  );
  return { chapter, content, url, selectors };
}

export async function fetchImage(url: string, outDir: string) {
  await assertSafeOutboundUrl(url);
  const res = await safeFetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch image: ${res.statusText}`);
  }

  const buffer = await readResponseBytes(res);
  const contentType = res.headers.get("content-type") || "image/jpeg";
  let ext = contentType.split("/")[1] || "";
  if (ext === "octet-stream") {
    ext = "jpeg";
  }
  if (!["jpeg", "jpg", "png", "svg", "webp", "gif", "bmp"].includes(ext)) {
    throw new Error(`Unsupported image format: ${ext}`);
  }

  const urlParts = new URL(url);
  const filename =
    (urlParts.pathname.split("/").pop() || "image-" + Date.now()) + "." + ext;
  const fullPath = path.join(outDir, filename);

  if (!(await fs.exists(outDir))) {
    await fs.mkdir(outDir, { recursive: true });
  }
  await fs.writeFile(fullPath, Buffer.from(buffer));

  return { fullPath, filename, contentType };
}

export function getSelector(el: HTMLElement, doc: Document) {
  const parts: string[] = [];
  let current: HTMLElement | null = el;
  let best = "";

  let depth = 0;
  while (current && current !== doc.body && depth < 10) {
    depth++;
    let seg = current.tagName.toLowerCase();
    let stop = false;
    if (current.id) {
      seg += `#${current.id}`;
      stop = true;
    } else {
      const classes = Array.from(current.classList)
        .filter((c) => {
          return !c.match(/^\d/) && c.length < 24 && !c.match(/\d{6,}/);
        })
        .slice(0, 3)
        .join(".");
      if (classes) seg += `.${classes}`;
      const siblings = current.parentElement
        ? Array.from(current.parentElement.children).filter(
            (c) =>
              c.tagName === current?.tagName &&
              (!current.classList.length ||
                c.classList.contains(current.classList[0]!)),
          )
        : [];
      if (siblings.length > 1) {
        seg += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      }
    }
    parts.unshift(seg);

    const candidate = parts.join(" > ");
    best = candidate;

    try {
      if (
        doc.querySelectorAll(candidate).length === 1 &&
        doc.querySelector(candidate) === el
      ) {
        return candidate;
      }
    } catch {
      // malformed selector (e.g. CSS-special characters in a class name) —
      // treat as non-unique and keep walking
    }

    if (stop) break;
    current = current.parentElement;
  }

  return best;
}

function getDepth(el: HTMLElement) {
  let d = 0;
  let cur: HTMLElement | null = el;
  while (cur) {
    d++;
    cur = cur.parentElement;
  }
  return d;
}

function isEmpty(el: HTMLElement) {
  const text = el.textContent?.replace(/\u00A0/g, " ").trim() ?? "";
  const hasMedia = el.querySelector("img, svg");
  return text === "" && !hasMedia;
}

function trimEmptyEdges(container: HTMLElement) {
  const children = Array.from(container.children) as HTMLElement[];

  let start = 0;
  let end = children.length - 1;

  while (start <= end && isEmpty(children[start]!)) start++;
  while (end >= start && isEmpty(children[end]!)) end--;

  children.slice(0, start).forEach((el) => el.remove());
  children.slice(end + 1).forEach((el) => el.remove());
}

export function findContentSelector(html: string) {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const scores = new Map<HTMLElement, number>();

  const containers: NodeListOf<HTMLElement> = doc.body.querySelectorAll(
    "div, article, section, main",
  );
  for (const el of containers) {
    const textElements = el.querySelectorAll("p");
    const text = [...textElements]
      .map((p) => p.textContent?.trim() ?? "")
      .join(" ");
    if (textElements.length < 3 || text.length < 40) continue;

    const depth = getDepth(el);
    let score =
      1 + textElements.length + Math.floor(text.length / 120) + depth * 5;
    scores.set(el, (scores.get(el) || 0) + score);

    const parent = el.parentElement;
    if (parent) {
      scores.set(parent, (scores.get(parent) || 0) + score * 0.5);
    }
  }

  // images
  for (const el of Array.from(doc.querySelectorAll("*"))) {
    if (!(el instanceof dom.window.HTMLElement)) continue;

    const imgs = el.querySelectorAll("img").length;
    if (imgs < 3) continue;

    const text = el.textContent?.trim() ?? "";
    const textLength = text.length;

    if (textLength < 200) {
      scores.set(el, (scores.get(el) || 0) + imgs * 4);
    } else {
      scores.set(el, (scores.get(el) || 0) + imgs * 2);
    }
  }

  // best element
  let best: HTMLElement | null = null;
  let bestScore = 0;

  for (const [el, score] of scores) {
    const textLength = el.textContent?.trim()?.length ?? 1;
    const linkCount = el.querySelectorAll("a").length;
    const linkDensity = linkCount / textLength;
    const finalScore = score + linkDensity * 10;

    if (finalScore > bestScore) {
      bestScore = finalScore;
      best = el;
    }
  }

  if (!best) return null;

  trimEmptyEdges(best);

  // Find chapter title
  let title = "";
  let titleSelector: string | null = "";

  const titleEl = [
    ...(best.parentElement || best).querySelectorAll(
      "h1, h2, h3, h4, b, strong, p:first-of-type",
    ),
  ]
    .filter((el) => el.textContent?.trim().length)
    .sort((a, b) => a.tagName.localeCompare(b.tagName))[0];

  if (titleEl) {
    title = titleEl.textContent?.trim() || "";
    titleSelector = getSelector(titleEl as HTMLElement, doc);
  }

  return {
    selector: getSelector(best, doc),
    element: best,
    html: best.innerHTML.trim(),
    title,
    titleSelector,
  };
}

export function extractFonts(page: Page) {
  const fonts = new Set<string>();

  page.on("response", (res) => {
    const req = res.request();
    const type = req.resourceType();
    const url = new URL(req.url());

    // ignore external fonts
    if (
      [
        "fonts.googleapis.com",
        "fonts.gstatic.com",
        "cdn.jsdelivr.net",
        "ajax.googleapis.com",
      ].includes(url.hostname)
    )
      return;

    const filename = url.pathname.split("/").pop() || "";

    if (
      filename.startsWith("fa-solid") ||
      filename.startsWith("fa-regular") ||
      filename.startsWith("fa-brands")
    ) {
      return;
    }

    if (type === "font") {
      fonts.add(url.toString());
    }

    // fallback if site mislabels resource type
    const ct = res.headers()["content-type"] || "";
    if (ct.includes("font") || ct.includes("woff")) {
      fonts.add(url.toString());
    }
  });

  return fonts;
}

/**
 * Collect the HTML of every block matched by any of the content selectors.
 *
 * `$(selector).html()` returns only the FIRST match's inner HTML, so a selector
 * that matched several sibling blocks — an intro paragraph, the body div, a
 * translator's note — silently dropped everything after the first. This walks
 * the whole union instead, in document order, and skips any element already
 * contained by one it has collected, so overlapping selectors cannot emit the
 * same paragraph twice.
 */
export function collectContentHtml(
  $: cheerio.CheerioAPI,
  selectors: string | string[] | null | undefined,
) {
  const list = (Array.isArray(selectors) ? selectors : [selectors]).filter(
    (selector): selector is string =>
      typeof selector === "string" && selector.trim().length > 0,
  );

  if (list.length === 0) return "";

  const missing = list.filter((selector) => $(selector).length === 0);
  if (missing.length > 0) {
    // Selector strings only — never page content.
    console.warn(`content selector matched nothing: ${missing.join(" | ")}`);
  }

  const collected = new Set<unknown>();
  const blocks: string[] = [];

  for (const element of $(list.join(", ")).toArray()) {
    let contained = false;
    for (let node = element.parent; node; node = node.parent) {
      if (collected.has(node)) {
        contained = true;
        break;
      }
    }

    if (contained) continue;

    collected.add(element);
    blocks.push($.html(element));
  }

  return blocks.join("\n");
}

export async function extractArticle(
  html: string,
  selector?: string | string[] | null,
) {
  if (Array.isArray(selector) ? selector.length > 0 : Boolean(selector)) {
    const $ = cheerio.load(html);
    const content = collectContentHtml($, selector).trim();
    return {
      title: "",
      author: "",
      content,
      language: "",
    };
  }

  try {
    const article = await extractus.extractFromHtml(html);
    if (!article?.content || article.content.length < 320) {
      throw new Error("No content found");
    }

    return {
      title: article?.title,
      author: article?.author,
      content: article?.content,
      language: undefined,
    };
  } catch {}

  try {
    const doc = new JSDOM(html);
    const article = new Readability(doc.window.document).parse();
    if (!article?.content || article.content.length < 320) {
      throw new Error("No content found");
    }

    return {
      title: article?.title || article?.siteName,
      author: article?.byline,
      content: article?.content,
      language: article?.lang,
    };
  } catch {}

  const article = findContentSelector(html);

  return {
    title: article?.title,
    author: "",
    content: article?.html,
    language: "",
  };
}

export function findChapterTitle(doc: Document) {
  // Find chapter title
  let title = "";
  let titleSelector: string | null = "";

  const titleEl = [
    ...doc.querySelectorAll("h1, h2, h3, h4, b, strong, p:first-of-type"),
  ]
    .filter((el) => el.textContent?.trim().length)
    .sort((a, b) => a.tagName.localeCompare(b.tagName))[0];

  if (titleEl) {
    title = titleEl.textContent?.trim() || "";
    titleSelector = getSelector(titleEl as HTMLElement, doc);
  }

  return { title, titleSelector };
}

export async function tryExtractContent(
  page: Page,
  url: string,
  options?: {
    fontDecryptMap?: Record<string, string> | null;
    selector?: string | string[] | null;
    framePath?: FramePath | null;
  },
) {
  const fonts = extractFonts(page);

  await assertSafeOutboundUrl(url);
  await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });

  // Content can live in an iframe; the document title stays the main frame's.
  const frame = await resolveFrame(page, options?.framePath);
  const [title, html] = await Promise.all([
    page.evaluate(() => document.title),
    frame.evaluate(getCleanHTML),
  ]);

  const article = await extractArticle(html, options?.selector);
  let content = article?.content || "";
  if (!article || !content) {
    throw new Error("Cannot extract content");
  }

  let fontDecryptMap: Record<string, string> | null =
    options?.fontDecryptMap || null;
  if (fontDecryptMap) {
    const decryptor = FontDecryptor.fromMap(fontDecryptMap);
    content = decryptor.decrypt(content);
  }

  let isObfuscated = false;
  let fontIdx = 0;
  let hasNewDecryptMap = false;
  const fontArr = [...fonts];

  while (
    (isObfuscated = detectObfuscatedContent(content)?.encrypted) &&
    fontIdx < Math.min(fontArr.length, 5)
  ) {
    const font = fontArr[fontIdx++];

    try {
      const res = await decryptTextFromFont([content], { fontUrl: font });

      if (res.map && res.result[0]) {
        fontDecryptMap = { ...(fontDecryptMap || {}), ...res.map };
        content = res.result[0];
        hasNewDecryptMap = true;
      }
    } catch {}
  }

  const contentEl = new JSDOM(content);
  const chapter = findChapterTitle(contentEl.window.document);

  return {
    title: title || "",
    chapter: chapter?.title || article?.title || "",
    author: article?.author || "",
    content,
    language: article?.language || "",
    isObfuscated,
    fonts,
    fontDecryptMap,
    hasNewDecryptMap,
  };
}

export async function getProjectConfig(id: string) {
  const data = await db
    .selectFrom("projects")
    .select("config")
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
  return data.config ? JSON.parse(data.config) : {};
}

export async function updateProjectConfig(id: string, values: any) {
  const config = await getProjectConfig(id);
  const newConfig = { ...config, ...values };
  await db
    .updateTable("projects")
    .set({ config: JSON.stringify(newConfig) })
    .where("id", "=", id)
    .execute();
}
