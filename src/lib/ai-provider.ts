import removeMd from "remove-markdown";
import { z } from "zod";
import { SelectorSchema, selectorExample } from "../app/projects/schema";
import { aiExecutor } from "./bounded-executor";
import { limits } from "./limits";

export type AiProvider = "ollama" | "gemini" | "mistral" | "none";

export const DEFAULT_OLLAMA_MODEL = "qwen2.5-coder:7b";
export const DEFAULT_MISTRAL_MODEL = "mistral-large-latest";

/** Every provider, in the order `AI_PROVIDER=auto` prefers them. */
const PROVIDER_ORDER = ["ollama", "gemini", "mistral"] as const;

/** The setting that turns each provider on; named in errors so the fix is obvious. */
const PROVIDER_SETTING: Record<(typeof PROVIDER_ORDER)[number], string> = {
  ollama: "OLLAMA_URL",
  gemini: "GEMINI_API_KEY",
  mistral: "MISTRAL_API_KEY",
};

/** Shown wherever a request needs a model and none is configured. */
export const NO_AI_PROVIDER_MESSAGE =
  "No AI provider configured: set OLLAMA_URL for a local model, or MISTRAL_API_KEY or GEMINI_API_KEY for a hosted model";

type Resolved =
  | { provider: "ollama"; ollamaUrl: URL; ollamaModel: string }
  | { provider: "gemini" }
  | { provider: "mistral"; mistralKey: string; mistralModel: string }
  | { provider: "none" };

/**
 * Which backend generates selectors, and where it lives.
 *
 * `OLLAMA_URL` is validated here as a **trusted operator endpoint**, at startup.
 * It deliberately does not run the SSRF guard that scraped URLs go through:
 * that policy rejects loopback and private addresses, and an operator pointing
 * Storvi at their own machine is exactly the case it would refuse — Docker's
 * `host-gateway` and a local daemon both land in private ranges. Loosening the
 * policy to accommodate this would punch a hole in it for scraped URLs too, so
 * the scheme and credential checks live here instead. The hosted backends have
 * the same standing: their URLs are compiled in, never taken from a page.
 *
 * `AI_PROVIDER` forces one (`ollama`, `gemini`, `mistral`), which matters because
 * `docker-compose.yml` sets `OLLAMA_URL` for the whole stack: on a host where
 * that sidecar cannot run, auto-detection would keep choosing a dead endpoint.
 */
export function resolveAiProvider(
  env: Record<string, string | undefined> = process.env,
): Resolved {
  const requested = env.AI_PROVIDER?.trim().toLowerCase() || "auto";

  if (requested !== "auto" && !PROVIDER_ORDER.includes(requested as "ollama")) {
    throw new Error(
      `AI_PROVIDER must be auto, ${PROVIDER_ORDER.join(", ")} — got "${requested}"`,
    );
  }

  const candidates: Resolved[] = [
    resolveOllama(env),
    env.GEMINI_API_KEY?.trim() ? { provider: "gemini" } as const : { provider: "none" } as const,
    resolveMistral(env),
  ];

  if (requested === "auto") {
    return (
      candidates.find((candidate) => candidate.provider !== "none") ?? {
        provider: "none",
      }
    );
  }

  const picked = candidates.find((candidate) => candidate.provider === requested);
  if (!picked) {
    throw new Error(
      `AI_PROVIDER=${requested} needs ${PROVIDER_SETTING[requested as "ollama"]}`,
    );
  }

  return picked;
}

function resolveOllama(env: Record<string, string | undefined>): Resolved {
  const rawUrl = env.OLLAMA_URL?.trim();
  if (!rawUrl) return { provider: "none" };

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`OLLAMA_URL is not a valid URL: ${rawUrl}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`OLLAMA_URL must be http or https, got ${url.protocol}`);
  }

  if (url.username || url.password) {
    throw new Error("OLLAMA_URL must not carry credentials in the URL");
  }

  return {
    provider: "ollama",
    ollamaUrl: url,
    ollamaModel: env.OLLAMA_MODEL?.trim() || DEFAULT_OLLAMA_MODEL,
  };
}

function resolveMistral(env: Record<string, string | undefined>): Resolved {
  const mistralKey = env.MISTRAL_API_KEY?.trim();
  if (!mistralKey) return { provider: "none" };

  return {
    provider: "mistral",
    mistralKey,
    mistralModel: env.MISTRAL_MODEL?.trim() || DEFAULT_MISTRAL_MODEL,
  };
}

/**
 * The prompt both backends share. Only the payload differs: the model gets the
 * reduced skeleton rather than whole-page HTML, because a 7B model on a shared
 * 8 GB card cannot fit a full page in its context.
 */
export function buildSelectorMessages(skeleton: string, followUp?: string) {
  const messages = [
    {
      role: "user",
      text:
        "You're a very good web scraper. Generate html selector to extract novel title, chapter, & content from html using cheerio.\n" +
        "The web maybe have anti scrape such as random classname, so find the best selector. If classname is random like `a.mb0` or `.cl54`, use the element itself. " +
        "If the element is div/span and have classname, dont specify the element, just the class itself, like `div.cha-title` -> `.cha-title`. " +
        "If the title contain chapter number, set `isChapterInTitle` to true and fill out `titleSeparator`, like '-'. If there are prev/next chapter links, fill out `urls`.\n" +
        "Text nodes appear as «123» placeholders recording their length; use the lengths and the surrounding structure to pick blocks.\n" +
        "Output only as JSON, no other text.\n" +
        "Example output: \n" +
        JSON.stringify(selectorExample) +
        "\n\nNow Start:\n" +
        skeleton,
    },
  ];

  if (followUp) {
    messages.push({ role: "user", text: followUp });
  }

  return messages;
}

/**
 * Structured-output schema derived from `SelectorSchema` itself, so the model's
 * output and the validator cannot drift.
 *
 * `io: "input"` is required, not decorative: `SelectorSchema.content` carries a
 * transform (plan 020 normalizes one selector or several into a list) and zod
 * refuses to represent transforms in JSON Schema. The input side is also the
 * correct direction — the model emits a document that must parse *into*
 * SelectorSchema.
 */
export function selectorJsonSchema() {
  return z.toJSONSchema(SelectorSchema, { io: "input" });
}

/**
 * Local inference is serialized: a second generation would compete for the same
 * 8 GB of VRAM. Chaining onto one promise and releasing in `finally` keeps the
 * queue alive when a request fails.
 */
let ollamaQueue: Promise<unknown> = Promise.resolve();

export async function generateSelectorsWithOllama(
  skeleton: string,
  followUp: string | undefined,
  config: { url: URL; model: string },
) {
  const run = async () => {
    const startedAt = Date.now();
    const messages = buildSelectorMessages(skeleton, followUp).map((m) => ({
      role: m.role,
      content: m.text,
    }));

    const response = await fetch(new URL("/api/chat", config.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.model,
        messages,
        stream: false,
        format: selectorJsonSchema(),
      }),
      signal: AbortSignal.timeout(limits.aiRequestTimeoutMs),
    });

    if (!response.ok) {
      // Status and model only: the body can contain page content.
      throw new Error(
        `Ollama request failed with ${response.status} from model ${config.model}`,
      );
    }

    const payload = (await response.json()) as {
      message?: { content?: string };
    };
    const content = payload?.message?.content;
    if (!content) {
      throw new Error(`Ollama returned no message content from ${config.model}`);
    }

    console.log(
      `selector generation via ollama/${config.model} took ${Date.now() - startedAt}ms`,
    );

    // `format` should make this unnecessary; a model that ignores the schema
    // should produce a clean error rather than a crash.
    return JSON.parse(removeMd(content));
  };

  const result = ollamaQueue.then(run, run);
  ollamaQueue = result.catch(() => undefined);
  return result;
}

/** Compiled in, never taken from a page — the same standing as OLLAMA_URL. */
const MISTRAL_CHAT_URL = "https://api.mistral.ai/v1/chat/completions";

/**
 * Selector generation on Mistral's chat completions API.
 *
 * No local queue here: nothing shared is being contended for, so concurrency is
 * whichever bound the shared AI executor already applies.
 *
 * `response_format: json_object` is Mistral's JSON mode — it guarantees an
 * object without constraining *which* keys, and it requires the word "json" to
 * appear in the prompt, which `buildSelectorMessages` already ends with. The
 * shape itself is pinned by `SelectorSchema.parse` at the call site, and the
 * prompt carries an example of it.
 */
export async function generateSelectorsWithMistral(
  skeleton: string,
  followUp: string | undefined,
  config: { apiKey: string; model: string },
) {
  const startedAt = Date.now();
  const messages = buildSelectorMessages(skeleton, followUp).map(({ role, text }) => ({
    role,
    content: text,
  }));

  const response = await aiExecutor.run(() =>
    fetch(MISTRAL_CHAT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        response_format: { type: "json_object" },
        stream: false,
      }),
      signal: AbortSignal.timeout(limits.aiRequestTimeoutMs),
    }),
  );

  if (!response.ok) {
    // Status and model only: an error body can echo page content, and a
    // rejected key must not appear in a log line.
    throw new Error(
      `Mistral request failed with ${response.status} from model ${config.model}`,
    );
  }

  const payload = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = payload?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error(`Mistral returned no message content from ${config.model}`);
  }

  console.log(
    `selector generation via mistral/${config.model} took ${Date.now() - startedAt}ms`,
  );

  return JSON.parse(removeMd(content));
}
