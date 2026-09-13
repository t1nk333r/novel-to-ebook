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

/** Offered in the project settings, with the RTL cases spelled out. */
export const LANGUAGES: { code: string; label: string }[] = [
  { code: "en", label: "English" },
  { code: "ar", label: "العربية — Arabic (right-to-left)" },
  { code: "ur", label: "اردو — Urdu (right-to-left)" },
  { code: "fa", label: "فارسی — Persian (right-to-left)" },
  { code: "he", label: "עברית — Hebrew (right-to-left)" },
  { code: "id", label: "Bahasa Indonesia" },
  { code: "ms", label: "Bahasa Melayu" },
  { code: "ja", label: "日本語 — Japanese" },
  { code: "ko", label: "한국어 — Korean" },
  { code: "zh", label: "中文 — Chinese" },
  { code: "hi", label: "हिन्दी — Hindi" },
  { code: "es", label: "Español" },
  { code: "fr", label: "Français" },
  { code: "de", label: "Deutsch" },
  { code: "pt", label: "Português" },
  { code: "ru", label: "Русский" },
  { code: "tr", label: "Türkçe" },
  { code: "vi", label: "Tiếng Việt" },
  { code: "th", label: "ไทย — Thai" },
];
