import sanitizeHtml from "sanitize-html";
import { GoogleGenAI } from "@google/genai";
import { SelectorSchema } from "../app/projects/schema";
import removeMd from "remove-markdown";
import {
  buildSelectorMessages,
  generateSelectorsWithOllama,
  resolveAiProvider,
} from "./ai-provider";
import { aiExecutor } from "./bounded-executor";

let ai: GoogleGenAI | null = null;

function getAI() {
  ai ??= new GoogleGenAI({});
  return ai;
}

/**
 * Generate selectors for a page, using whichever backend the operator has
 * configured. `html` is expected to be a reduced skeleton (see `htmlSkeleton`):
 * a local 7B model cannot fit whole-page HTML in its context.
 *
 * `SelectorSchema.parse` stays the single validation point for both backends.
 */
export async function generateSelectors(html: string, followUp?: string) {
  const config = resolveAiProvider();

  let generated: unknown;

  if (config.provider === "ollama") {
    generated = await generateSelectorsWithOllama(html, followUp, {
      url: config.ollamaUrl,
      model: config.ollamaModel,
    });
  } else if (config.provider === "gemini") {
    generated = await generateSelectorsWithGemini(html, followUp);
  } else {
    throw new Error(
      "No AI provider configured: set OLLAMA_URL for a local model or GEMINI_API_KEY for Gemini",
    );
  }

  return SelectorSchema.parse(generated);
}

async function generateSelectorsWithGemini(html: string, followUp?: string) {
  const response = await aiExecutor.run(() =>
    getAI().models.generateContent({
      model: "gemini-2.5-flash",
      contents: buildSelectorMessages(html, followUp),
    }),
  );
  if (!response.text) {
    throw new Error("No response");
  }

  return JSON.parse(removeMd(response.text));
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

/**
 * Run `mapper` over `items` with at most `limit` in flight, preserving input
 * order in the result. Used by the library scan, where unbounded `Promise.all`
 * over a large library opened every book at once.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
) {
  const results = new Array<R>(items.length);
  const budget = Math.max(1, Math.min(Math.trunc(limit) || 1, items.length));
  let next = 0;

  async function worker() {
    while (true) {
      signal?.throwIfAborted();
      const index = next++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index] as T, index);
    }
  }

  await Promise.all(Array.from({ length: budget }, () => worker()));
  return results;
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
