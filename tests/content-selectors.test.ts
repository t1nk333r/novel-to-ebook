import { describe, expect, test } from "bun:test";
import * as cheerio from "cheerio";
import { collectContentHtml } from "../src/app/projects/utils";
import { SelectorSchema } from "../src/app/projects/schema";

function collect(html: string, selectors: string | string[]) {
  return collectContentHtml(cheerio.load(html), selectors);
}

const SIBLINGS = `
  <div class="intro">intro paragraph</div>
  <div class="body">body paragraph</div>
  <aside class="note">translator note</aside>
`;

describe("collectContentHtml", () => {
  test("single selector with a single match is unchanged", () => {
    const html = collect(
      `<div class="body"><p>Only block</p></div>`,
      "div.body",
    );

    expect(html).toBe('<div class="body"><p>Only block</p></div>');
  });

  test("a selector matching several siblings returns all of them, in document order", () => {
    const html = collect(SIBLINGS, "div");

    expect(html).toContain("intro paragraph");
    expect(html).toContain("body paragraph");
    expect(html.indexOf("intro paragraph")).toBeLessThan(
      html.indexOf("body paragraph"),
    );
  });

  test("several selectors are merged in document order, not selector order", () => {
    const html = collect(SIBLINGS, ["aside.note", "div.intro", "div.body"]);

    expect(html.indexOf("intro paragraph")).toBeLessThan(
      html.indexOf("body paragraph"),
    );
    expect(html.indexOf("body paragraph")).toBeLessThan(
      html.indexOf("translator note"),
    );
  });

  test("a nested match is not emitted twice", () => {
    const html = collect(
      `<div class="body"><p class="inner">once</p></div>`,
      ["div.body", "p.inner"],
    );

    expect(html.match(/once/g)).toHaveLength(1);
    expect(html).toBe('<div class="body"><p class="inner">once</p></div>');
  });

  test("a selector matching nothing is skipped without losing the others", () => {
    const html = collect(SIBLINGS, ["div.intro", "section.absent"]);

    expect(html).toContain("intro paragraph");
    expect(html).not.toContain("body paragraph");
  });

  test("the outer element is kept, not just its inner html", () => {
    const html = collect(SIBLINGS, ["div.body"]);

    expect(html.startsWith('<div class="body">')).toBe(true);
    expect(html.endsWith("</div>")).toBe(true);
  });

  test("no selector matches anything -> empty result", () => {
    expect(collect(SIBLINGS, ["section.absent"])).toBe("");
    expect(collect(SIBLINGS, [])).toBe("");
    expect(collect(SIBLINGS, null)).toBe("");
  });

  test("a comma union in one string behaves like a list", () => {
    const html = collect(SIBLINGS, "div.intro, div.body");

    expect(html).toContain("intro paragraph");
    expect(html).toContain("body paragraph");
  });
});

describe("SelectorSchema content back-compat", () => {
  const base = { title: "A novel" };

  test("a legacy single-string content selector normalizes to a list", () => {
    const parsed = SelectorSchema.parse({
      ...base,
      content: "div.reading-content",
    });

    expect(parsed.content).toEqual(["div.reading-content"]);
  });

  test("a list passes through unchanged", () => {
    const parsed = SelectorSchema.parse({
      ...base,
      content: ["div.intro", "div.body"],
    });

    expect(parsed.content).toEqual(["div.intro", "div.body"]);
  });

  test("an over-long list is rejected", () => {
    const many = Array.from({ length: 21 }, (_, i) => `div.block-${i}`);

    expect(SelectorSchema.safeParse({ ...base, content: many }).success).toBe(
      false,
    );
  });
});
