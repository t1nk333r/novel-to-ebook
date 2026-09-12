import sanitizeHtml from "sanitize-html";
import { GoogleGenAI } from "@google/genai";
import { selectorExample, SelectorSchema } from "../app/projects/schema";
import removeMd from "remove-markdown";
import { aiExecutor } from "./bounded-executor";

let ai: GoogleGenAI | null = null;

function getAI() {
  ai ??= new GoogleGenAI({});
  return ai;
}

export async function generateSelectors(html: string, followUp?: string) {
  const prompts = [
    {
      role: "user",
      text:
        "You're a very good web scraper. Generate html selector to extract novel title, chapter, & content from html using cheerio.\n" +
        "The web maybe have anti scrape such as random classname, so find the best selector. If classname is random like `a.mb0` or `.cl54`, use the element itself. " +
        "If the element is div/span and have classname, dont specify the element, just the class itself, like `div.cha-title` -> `.cha-title`. " +
        "If the title contain chapter number, set `isChapterInTitle` to true and fill out `titleSeparator`, like '-'. If there are prev/next chapter links, fill out `urls`.\n" +
        "Output only as JSON, no other text.\n" +
        "Example output: \n" +
        JSON.stringify(selectorExample) +
        "\n\nNow Start:\n" +
        html,
    },
  ];

  if (followUp) {
    prompts.push({
      role: "user",
      text: followUp,
    });
  }

  const response = await aiExecutor.run(() =>
    getAI().models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompts,
    }),
  );
  if (!response.text) {
    throw new Error("No response");
  }

  const res = JSON.parse(removeMd(response.text));
  return SelectorSchema.parse(res);
}

export async function translate(text: string, to = "en") {
  const response = await aiExecutor.run(() =>
    getAI().models.generateContent({
      model: "gemini-2.5-flash",
      contents: `Translate HTML to [${to.toUpperCase()}]:
    1. No Layout Changes: Keep all HTML tags exactly as they are. Translate only the text content inside.
    2. Literal Style: Maintain the original sentence structure, tone, and specific idioms. Do not over-localize or change the author's unique voice/pacing.
    3. No Meta-Talk: Output only the translated HTML. No explanations or notes.
    Content:\n\n${text}`,
    }),
  );

  return response.text;
}

export function cleanHTML(html: string) {
  return sanitizeHtml(html, {
    allowedTags: [
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "p",
      "span",
      "br",
      "strong",
      "b",
      "em",
      "i",
      "u",
      "img",
    ],

    allowedAttributes: {
      img: ["src", "alt", "title", "width", "height"],
      p: ["style"],
      span: ["style"],
    },

    allowedStyles: {
      "*": {
        "text-align": [/^left$/, /^right$/, /^center$/, /^justify$/],
      },
    },
  }).trim();
}

export async function waitFor(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function uuid() {
  return Bun.randomUUIDv7();
}
