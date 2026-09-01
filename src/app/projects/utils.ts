import { Page } from "puppeteer";
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

export async function extractArticle(html: string, selector?: string | null) {
  if (selector) {
    const $ = cheerio.load(html);
    const content = $(selector).html()?.trim();
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
    selector?: string | null;
  },
) {
  const fonts = extractFonts(page);

  await assertSafeOutboundUrl(url);
  await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
  const [title, html] = await Promise.all([
    page.evaluate(() => document.title),
    page.evaluate(getCleanHTML),
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
