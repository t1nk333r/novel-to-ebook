import { describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { getSelector } from "../src/app/projects/utils";

function assertUnique(doc: Document, selector: string, target: Element) {
  const matches = doc.querySelectorAll(selector);
  expect(matches.length).toBe(1);
  expect(doc.querySelector(selector)).toBe(target);
}

describe("getSelector", () => {
  test("element with an id uses the id and is unique", () => {
    const dom = new JSDOM(
      `<body><div><p id="target">Hello</p><p>Other</p></div></body>`,
    );
    const doc = dom.window.document;
    const target = doc.getElementById("target")!;

    const selector = getSelector(target as unknown as HTMLElement, doc);

    assertUnique(doc, selector, target);
  });

  test("one p among five sibling ps inside div.article must not match the other four", () => {
    const dom = new JSDOM(
      `<body><div class="article">
        <p>One</p>
        <p>Two</p>
        <p>Target</p>
        <p>Four</p>
        <p>Five</p>
      </div></body>`,
    );
    const doc = dom.window.document;
    const paragraphs = doc.querySelectorAll("div.article p");
    const target = paragraphs[2]!;

    const selector = getSelector(target as unknown as HTMLElement, doc);

    assertUnique(doc, selector, target);
  });

  test("ancestor div.chapter occurring three times must be disambiguated", () => {
    const dom = new JSDOM(
      `<body>
        <div class="chapter"><p>First</p></div>
        <div class="chapter"><p>Second</p></div>
        <div class="chapter"><p>Third</p></div>
      </body>`,
    );
    const doc = dom.window.document;
    const paragraphs = doc.querySelectorAll("div.chapter p");
    const target = paragraphs[2]!;

    const selector = getSelector(target as unknown as HTMLElement, doc);

    assertUnique(doc, selector, target);
  });

  test("element whose only classes are utility classes shared by many elements", () => {
    const dom = new JSDOM(
      `<body>
        <div class="flex p-2">
          <span class="flex p-2">A</span>
          <span class="flex p-2">B</span>
          <span class="flex p-2" id="not-used">C</span>
        </div>
        <div class="flex p-2">
          <span class="flex p-2">D</span>
        </div>
      </body>`,
    );
    const doc = dom.window.document;
    const spans = doc.querySelectorAll("span.flex.p-2");
    const target = spans[1]!;

    const selector = getSelector(target as unknown as HTMLElement, doc);

    assertUnique(doc, selector, target);
  });

  test("element directly under body", () => {
    const dom = new JSDOM(`<body><p>Only</p></body>`);
    const doc = dom.window.document;
    const target = doc.querySelector("p")!;

    const selector = getSelector(target as unknown as HTMLElement, doc);

    assertUnique(doc, selector, target);
  });

  test("genuinely indistinguishable target still returns a non-empty string without throwing", () => {
    const dom = new JSDOM(
      `<body>
        <div class="wrap"><p class="x">Same</p></div>
        <div class="wrap"><p class="x">Same</p></div>
      </body>`,
    );
    const doc = dom.window.document;
    const paragraphs = doc.querySelectorAll("div.wrap p.x");
    const target = paragraphs[1]!;

    let selector = "";
    expect(() => {
      selector = getSelector(target as unknown as HTMLElement, doc);
    }).not.toThrow();

    expect(selector.length).toBeGreaterThan(0);
  });
});
