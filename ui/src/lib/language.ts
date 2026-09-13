/**
 * Reading direction, from a book's language.
 *
 * The server writes `dc:language` into every export but the EPUB generator emits
 * no `page-progression-direction`, so foliate-js leaves every book left-to-right
 * and an Arabic book pages the wrong way. The language is what it does carry.
 *
 * Deliberately a copy of `src/lib/language.ts`: the UI bundle cannot import
 * server values, the same reason the title cleaner exists twice. A test asserts
 * the two lists agree, so they cannot drift silently.
 */
const RTL_LANGUAGES = new Set(["ar", "he", "fa", "ur", "yi", "dv", "ps", "sd", "ug", "ku"]);

export function isRtl(language: string | null | undefined) {
  const base = (language ?? "").trim().toLowerCase().split(/[-_]/)[0] ?? "";
  return RTL_LANGUAGES.has(base);
}
