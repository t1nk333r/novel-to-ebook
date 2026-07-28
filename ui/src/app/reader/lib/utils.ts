import api from "@/lib/api";
import { getDB } from "@/lib/db";
import type { BookRelocate } from "./types";
import { fontFamilies } from "./stores";

export type ReaderTheme = {
  background?: string;
  color?: string;
  linkColor?: string;
};
export type ReaderStyles = {
  spacing: number;
  justify: boolean;
  hyphenate: boolean;
  padding?: string;
  fontFamily?: string;
  fontSize?: number;
  minFontSize?: number;
  fontWeight?: number | string;
  theme?: { dark: ReaderTheme; light: ReaderTheme };
  colorScheme?: "dark" | "light";
};

export function getCSS({
  spacing,
  justify,
  hyphenate,
  padding = "0 0.5rem",
  fontFamily = "'Bitter', serif",
  fontSize = 16,
  minFontSize = 8,
  fontWeight = 400,
  theme,
  colorScheme = "dark",
}: ReaderStyles) {
  return `
    @namespace epub "http://www.idpf.org/2007/ops";
    :root {
      --theme-bg-color: ${theme?.[colorScheme]?.background || "#222"};
    }
    html {
      color-scheme: ${colorScheme};
    }
    html, body {
      padding: ${padding};
      -webkit-text-size-adjust: none;
      text-size-adjust: none;
      background: ${theme?.[colorScheme]?.background || "#222"}; 
    }
    * {
      font-size: ${fontSize}px !important;
      font-weight: ${fontWeight};
      font-family: ${fontFamily} !important;
      color: ${theme?.[colorScheme]?.color || "#fff"};
    }
    a:link {
      color: ${theme?.[colorScheme]?.linkColor || "lightblue"};
    }
    font[size="1"] {
      font-size: ${minFontSize}px;
    }
    font[size="2"] {
      font-size: ${minFontSize * 1.5}px;
    }
    font[size="3"] {
      font-size: ${fontSize}px;
    }
    font[size="4"] {
      font-size: ${fontSize * 1.2}px;
    }
    font[size="5"] {
      font-size: ${fontSize * 1.5}px;
    }
    font[size="6"] {
      font-size: ${fontSize * 2}px;
    }
    font[size="7"] {
      font-size: ${fontSize * 3}px;
    }
    p, li, blockquote, dd {
        line-height: ${spacing};
        text-align: ${justify ? "justify" : "start"};
        -webkit-hyphens: ${hyphenate ? "auto" : "manual"};
        hyphens: ${hyphenate ? "auto" : "manual"};
        -webkit-hyphenate-limit-before: 3;
        -webkit-hyphenate-limit-after: 2;
        -webkit-hyphenate-limit-lines: 2;
        hanging-punctuation: allow-end last;
        widows: 2;
    }
    /* prevent the above from overriding the align attribute */
    [align="left"] { text-align: left; }
    [align="right"] { text-align: right; }
    [align="center"] { text-align: center; }
    [align="justify"] { text-align: justify; }

    pre {
        white-space: pre-wrap !important;
    }
    aside[epub|type~="endnote"],
    aside[epub|type~="footnote"],
    aside[epub|type~="note"],
    aside[epub|type~="rearnote"] {
        display: none;
    }
`;
}

const additionalFonts = [
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  {
    rel: "preconnect",
    href: "https://fonts.gstatic.com",
    crossOrigin: "true",
  },
];

fontFamilies.forEach((font) => {
  additionalFonts.push({
    rel: "stylesheet",
    href: `https://fonts.googleapis.com/css2?family=${font.label}:ital,wght@0,100..900;1,100..900&display=swap`,
  });
});

export function injectAdditionalLinks(doc: Document) {
  additionalFonts.forEach((link) => {
    const child = doc.createElement("link");
    child.rel = link.rel;
    child.href = link.href;
    child.crossOrigin = link.crossOrigin || "";
    doc.head.appendChild(child);
  });
}

export async function getHistory(key: string): Promise<
  | {
      location: BookRelocate;
      date: Date;
    }
  | undefined
> {
  const cached = await getDB().then((db) => db.get("histories", key));

  try {
    const signal = AbortSignal.timeout(3000);
    const { data } = await api.GET("/library/progress", {
      params: { query: { key } },
      signal,
    });
    if (!data) {
      throw new Error("History not found");
    }

    const date = new Date(data.date);
    const location = data.location as BookRelocate;

    // return cached data if it's more recent
    if (cached && date < cached.date) {
      // console.log("using cached data becoz newer");
      return cached;
    }

    if (cached && date > cached.date) {
      // console.log("storing cache");
      await getDB().then((db) =>
        db.put("histories", { ...cached, location, date }, key),
      );
    }

    // console.log("using api data");
    return { location, date };
  } catch (err) {
    // console.log("using cached data", cached);
    return cached;
  }
}

export async function saveHistory(
  key: string,
  data: {
    name: string;
    metadata?: any;
    cover?: string | null;
    location: BookRelocate;
  },
) {
  const date = new Date();
  return Promise.all([
    getDB().then((db) =>
      db.put(
        "histories",
        {
          key,
          name: data.name,
          cover: data.cover,
          location: { ...data.location, range: {} },
          date: new Date(),
        },
        key,
      ),
    ),
    api.PUT("/library/progress", {
      body: { key, location: data.location, date: date.toISOString() },
    }),
  ]);
}
