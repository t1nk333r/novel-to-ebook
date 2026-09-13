/**
 * Right-to-left languages, by ISO 639-1 code — the set an EPUB's direction and a
 * reader's pagination care about. Arabic and its relatives, plus the two other
 * scripts that are written right to left and appear in translated fiction.
 */
const RTL_LANGUAGES = new Set(["ar", "he", "fa", "ur", "yi", "dv", "ps", "sd", "ug", "ku"]);

export function isRtl(language: string | null | undefined) {
  const base = (language ?? "").trim().toLowerCase().split(/[-_]/)[0] ?? "";
  return RTL_LANGUAGES.has(base);
}

/**
 * Chapter CSS for a right-to-left book. The generator has no direction option and
 * writes no `page-progression-direction`, so rendering is what we can guarantee:
 * with this, each paragraph lays out right-to-left and aligns to the right edge.
 */
export const RTL_CHAPTER_CSS = [
  "body { direction: rtl; text-align: right; }",
  "p, div, li { direction: rtl; text-align: right; }",
  'body { font-family: "Noto Naskh Arabic", "Amiri", "Scheherazade New", "Traditional Arabic", serif; }',
].join("\n");
