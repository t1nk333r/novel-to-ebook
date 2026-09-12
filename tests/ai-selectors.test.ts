import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  buildSelectorMessages,
  generateSelectorsWithOllama,
  resolveAiProvider,
  selectorJsonSchema,
} from "../src/lib/ai-provider";
import { htmlSkeleton } from "../src/app/projects/utils";
import { SelectorSchema } from "../src/app/projects/schema";

/**
 * Plan 022: selector generation against a local Ollama instance.
 *
 * Nothing here touches the network or a GPU — `fetch` is stubbed — so the suite
 * runs on any machine, including one without Ollama.
 */

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ url, body });
    return handler(url, init);
  }) as typeof fetch;
  return calls;
}

const jsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });

const VALID_REPLY = {
  title: "h1.title",
  chapter: null,
  content: "div.reading-content",
};

describe("resolveAiProvider", () => {
  test("prefers a configured Ollama endpoint, then Gemini, then nothing", () => {
    expect(
      resolveAiProvider({ OLLAMA_URL: "http://127.0.0.1:11435" }).provider,
    ).toBe("ollama");
    expect(resolveAiProvider({ GEMINI_API_KEY: "key" }).provider).toBe("gemini");
    expect(
      resolveAiProvider({ OLLAMA_URL: "http://x:1", GEMINI_API_KEY: "key" })
        .provider,
    ).toBe("ollama");
    expect(resolveAiProvider({}).provider).toBe("none");
  });

  test("defaults the model and honours an override", () => {
    const fallback = resolveAiProvider({ OLLAMA_URL: "http://ollama:11434" });
    expect(fallback.provider === "ollama" && fallback.ollamaModel).toBe(
      "qwen2.5-coder:7b",
    );

    const override = resolveAiProvider({
      OLLAMA_URL: "http://ollama:11434",
      OLLAMA_MODEL: "qwen2.5-coder:3b",
    });
    expect(override.provider === "ollama" && override.ollamaModel).toBe(
      "qwen2.5-coder:3b",
    );
  });

  test("validates the endpoint as a trusted operator URL", () => {
    // Private addresses are the expected case here — this is the operator's own
    // machine, not a scraped URL, and it is deliberately not run through the
    // SSRF policy.
    expect(() =>
      resolveAiProvider({ OLLAMA_URL: "http://127.0.0.1:11435" }),
    ).not.toThrow();
    expect(() =>
      resolveAiProvider({ OLLAMA_URL: "http://ollama:11434" }),
    ).not.toThrow();
    expect(() =>
      resolveAiProvider({ OLLAMA_URL: "https://gpu.internal:11434" }),
    ).not.toThrow();

    expect(() => resolveAiProvider({ OLLAMA_URL: "file:///etc/passwd" })).toThrow(
      /OLLAMA_URL/,
    );
    expect(() =>
      resolveAiProvider({ OLLAMA_URL: "http://user:pass@host:11434" }),
    ).toThrow(/credentials/);
    expect(() => resolveAiProvider({ OLLAMA_URL: "not a url" })).toThrow(
      /OLLAMA_URL/,
    );
  });
});

describe("selectorJsonSchema", () => {
  test("is derived from SelectorSchema and describes what a model must emit", () => {
    const schema = selectorJsonSchema() as {
      properties?: Record<string, unknown>;
      required?: string[];
    };

    expect(Object.keys(schema.properties ?? {})).toContain("title");
    expect(Object.keys(schema.properties ?? {})).toContain("content");
    expect(schema.required).toContain("title");

    // `content` is a transform, so it is only representable on the input side —
    // which is also the direction the model needs.
    expect(JSON.stringify(schema.properties?.content)).toContain("array");
  });

  test("the derived schema and the validator accept the same document", () => {
    expect(SelectorSchema.safeParse(VALID_REPLY).success).toBe(true);
    expect(SelectorSchema.parse(VALID_REPLY).content).toEqual([
      "div.reading-content",
    ]);
  });
});

describe("htmlSkeleton", () => {
  const page = `<!doctype html><html><head><style>p{color:red}</style>
    <script>window.secret = 1</script></head>
    <body><div id="app" class="novel">
      <h1 class="cha-title">Chapter 12 — The Long Road</h1>
      <div class="content"><p>${"word ".repeat(40)}</p></div>
      <ul class="chapters">${Array.from({ length: 40 }, (_, i) => `<li class="ch"><a href="/c${i}">Chapter ${i}</a></li>`).join("")}</ul>
    </div></body></html>`;

  test("keeps structure, drops scripts and text", () => {
    const skeleton = htmlSkeleton(page, 60_000);

    expect(skeleton).toContain('id="app"');
    expect(skeleton).toContain('class="novel"');
    expect(skeleton).toContain("cha-title");
    expect(skeleton).not.toContain("script");
    expect(skeleton).not.toContain("color:red");
    expect(skeleton).not.toContain("Chapter 12");
    expect(skeleton).not.toContain("window.secret");
  });

  test("replaces text with a length marker instead of the words", () => {
    const skeleton = htmlSkeleton(page, 60_000);

    expect(skeleton).toMatch(/«\d+»/);
    expect(skeleton).not.toContain("word word");
  });

  test("collapses a long run of identical siblings", () => {
    const skeleton = htmlSkeleton(page, 60_000);

    expect(skeleton).toContain("more");
    // Three examples plus the marker, not forty copies.
    expect(skeleton.match(/<li class="ch">/g)?.length).toBe(3);
  });

  test("truncates at an element boundary within the byte budget", () => {
    const long = `<html><body>${Array.from(
      { length: 60 },
      (_, i) => `<section class="block-${i}"><p>${"x".repeat(20)}</p></section>`,
    ).join("")}</body></html>`;
    const skeleton = htmlSkeleton(long, 300);

    expect(skeleton.length).toBeLessThanOrEqual(320);
    expect(skeleton.endsWith("«truncated»")).toBe(true);
  });

  test("reduces a realistic page by at least 10x", () => {
    const prose = `<article class="chapter">
      <h2>Chapter</h2>
      ${Array.from({ length: 120 }, (_, i) => `<p>Paragraph ${i} ${"lorem ipsum dolor sit amet ".repeat(6)}</p>`).join("")}
    </article>`;
    const skeleton = htmlSkeleton(`<html><body>${prose}</body></html>`, 60_000);

    expect(skeleton.length * 10).toBeLessThan(prose.length);
  });
});

describe("generateSelectorsWithOllama", () => {
  const config = { url: new URL("http://127.0.0.1:11435"), model: "test-model" };

  test("posts to /api/chat with the model, non-streaming, and a format schema", async () => {
    const calls = stubFetch(() =>
      jsonResponse({ message: { content: JSON.stringify(VALID_REPLY) } }),
    );

    const result = await generateSelectorsWithOllama("<div>«10»</div>", undefined, config);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://127.0.0.1:11435/api/chat");
    expect(calls[0]?.body.model).toBe("test-model");
    expect(calls[0]?.body.stream).toBe(false);
    expect(calls[0]?.body.format).toBeDefined();
    expect(SelectorSchema.parse(result).title).toBe("h1.title");
  });

  test("sends the skeleton, never the raw page", async () => {
    const calls = stubFetch(() =>
      jsonResponse({ message: { content: JSON.stringify(VALID_REPLY) } }),
    );

    await generateSelectorsWithOllama("<p>«42»</p>", "try harder", config);

    const messages = calls[0]?.body.messages as { content: string }[];
    expect(messages).toHaveLength(2);
    expect(messages[0]?.content).toContain("<p>«42»</p>");
    expect(messages[1]?.content).toBe("try harder");
  });

  test("a non-2xx error names the status and model but not the body", async () => {
    stubFetch(() =>
      new Response("SECRET PAGE CONTENT leaking out", { status: 500 }),
    );

    const error = await generateSelectorsWithOllama("x", undefined, config).catch(
      (err: Error) => err,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("500");
    expect((error as Error).message).toContain("test-model");
    expect((error as Error).message).not.toContain("SECRET PAGE CONTENT");
  });

  test("a malformed reply is a clear error, not a crash", async () => {
    stubFetch(() => jsonResponse({ message: { content: "not json at all" } }));

    await expect(
      generateSelectorsWithOllama("x", undefined, config),
    ).rejects.toThrow();
  });

  test("an empty reply is rejected", async () => {
    stubFetch(() => jsonResponse({ message: {} }));

    await expect(
      generateSelectorsWithOllama("x", undefined, config),
    ).rejects.toThrow(/no message content/i);
  });
});

describe("local inference serialization", () => {
  test("two concurrent requests never overlap", async () => {
    let inFlight = 0;
    let peak = 0;
    // A gate the test opens once: without serialization both requests would be
    // in flight when it opens, which is what `peak` measures. No wall-clock
    // timing involved.
    const gate = Promise.withResolvers<void>();

    globalThis.fetch = (async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await gate.promise;
      inFlight--;
      return jsonResponse({ message: { content: JSON.stringify(VALID_REPLY) } });
    }) as typeof fetch;

    const config = { url: new URL("http://127.0.0.1:11435"), model: "m" };
    const both = Promise.all([
      generateSelectorsWithOllama("a", undefined, config),
      generateSelectorsWithOllama("b", undefined, config),
    ]);

    gate.resolve();
    await both;

    expect(peak).toBe(1);
  });

  test("a failed request releases the queue for the next one", async () => {
    let call = 0;
    stubFetch(() => {
      call++;
      if (call === 1) return new Response("boom", { status: 500 });
      return jsonResponse({ message: { content: JSON.stringify(VALID_REPLY) } });
    });

    const config = { url: new URL("http://127.0.0.1:11435"), model: "m" };
    await generateSelectorsWithOllama("a", undefined, config).catch(() => null);

    // Would hang forever if the queue slot leaked.
    await expect(
      generateSelectorsWithOllama("b", undefined, config),
    ).resolves.toBeDefined();
  });
});

describe("prompt construction", () => {
  test("carries the skeleton and explains the length markers", () => {
    const [first] = buildSelectorMessages("<div>«7»</div>");

    expect(first?.text).toContain("<div>«7»</div>");
    expect(first?.text).toContain("placeholders");
    expect(z.string().safeParse(first?.text).success).toBe(true);
  });
});
