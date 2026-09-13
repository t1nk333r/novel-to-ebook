import * as cheerio from "cheerio";
import { openZip } from "../../lib/zip";

/**
 * Read an EPUB into chapters.
 *
 * The app writes EPUBs and had no way to read one back, so a book in the library
 * with no project behind it could only be read, never edited or re-exported.
 * This turns such a file into the project it should have had.
 *
 * Pure: takes bytes, returns data. The caller does the database work, and a test
 * can exercise the parsing without a server.
 */

export type AdoptedChapter = { title: string; html: string };
export type AdoptedBook = {
  title: string | null;
  author: string | null;
  language: string | null;
  chapters: AdoptedChapter[];
};

function decodeEntities(text: string) {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (whole, code: string) => {
      const value = Number(code);
      return value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : whole;
    });
}

/** Resolve an OPF-relative href against the OPF's own directory. */
function resolveHref(href: string, opfPath: string) {
  const base = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";
  const joined = `${base}${href}`;
  const parts: string[] = [];
  for (const segment of decodeURIComponent(joined).split("/")) {
    if (segment === "." || segment === "") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return parts.join("/");
}

export function readEpub(input: Uint8Array): AdoptedBook {
  const archive = openZip(input);

  // The OPF is found through the container, which is what the spec is for; a
  // missing container falls back to any .opf, because some tools omit it.
  const container = archive.text("META-INF/container.xml") ?? "";
  const opfPath =
    container.match(/full-path="([^"]+)"/)?.[1] ?? archive.names.find((name) => name.endsWith(".opf"));

  if (!opfPath) throw new Error("that file has no OPF — it is not an EPUB");
  const opf = archive.text(opfPath);
  if (!opf) throw new Error(`the EPUB's package document (${opfPath}) is missing`);

  const $ = cheerio.load(opf, { xmlMode: true });

  // Metadata by regex: the elements are namespaced (`dc:title`), and a regex is
  // namespace-agnostic where an escaped CSS selector is a guessing game.
  const meta = (name: string) => {
    const found = opf.match(new RegExp(`<(?:dc:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:dc:)?${name}>`, "i"));
    const value = found?.[1]?.replace(/<[^>]*>/g, "").trim();
    return value ? decodeEntities(value) : null;
  };

  const manifest = new Map<string, { href: string; type: string; properties: string }>();
  $("manifest item, item").each((_, element) => {
    const id = $(element).attr("id");
    const href = $(element).attr("href");
    if (id && href) {
      manifest.set(id, {
        href,
        type: $(element).attr("media-type") ?? "",
        properties: $(element).attr("properties") ?? "",
      });
    }
  });

  const order = $("spine itemref, itemref")
    .map((_, element) => $(element).attr("idref") ?? "")
    .get()
    .filter(Boolean);

  // No spine means the document order is unknown; the manifest's documents in
  // whatever order they appear is the best available answer.
  // The table of contents is a document in the spine but not a chapter; our own
  // exports mark it `properties="nav"`, and some tools only name it.
  const isNav = (entry: { href: string; properties: string }) =>
    /\bnav\b/i.test(entry.properties) || /(^|\/)(toc|nav)\.x?html$/i.test(entry.href);

  const documents = (
    order.length
      ? order.map((id) => manifest.get(id))
      : [...manifest.values()].filter((entry) => /xhtml|html/.test(entry.type) || /\.x?html$/i.test(entry.href))
  )
    .filter((entry): entry is { href: string; type: string; properties: string } => Boolean(entry))
    .filter((entry) => !isNav(entry));

  const chapters: AdoptedChapter[] = [];

  for (const document_ of documents) {
    const path = resolveHref(document_.href, opfPath);
    const raw = archive.text(path);
    if (!raw) continue;

    const page = cheerio.load(raw);
    page("script, style").remove();

    const body = page("body").first();
    const html = (body.length ? body.html() : page.root().html()) ?? "";
    if (!html.replace(/<[^>]*>/g, "").trim()) continue;

    const heading = page("h1, h2, h3").first().text().replace(/\s+/g, " ").trim();
    const documentTitle = page("title").first().text().replace(/\s+/g, " ").trim();
    const fromFile = path.split("/").pop()?.replace(/\.[a-z0-9]+$/i, "") ?? "";

    chapters.push({
      title: decodeEntities(heading || documentTitle || fromFile || "Untitled"),
      html,
    });
  }

  if (chapters.length === 0) throw new Error("no readable chapters in that EPUB");

  return {
    title: meta("title"),
    author: meta("creator"),
    language: meta("language"),
    chapters,
  };
}
