import { describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import type { Page } from "puppeteer";
import { execActions } from "../src/lib/browser";
import type { Action } from "../src/app/projects/schema";

function createPageDouble(html: string) {
  const dom = new JSDOM(html);
  (globalThis as any).document = dom.window.document;

  let clicked = false;
  const originalClick = dom.window.HTMLElement.prototype.click;
  dom.window.HTMLElement.prototype.click = function (this: HTMLElement) {
    clicked = true;
    return originalClick?.call(this);
  };

  const page = {
    evaluate: async (fn: (...args: any[]) => unknown, ...args: any[]) =>
      fn(...args),
  } as unknown as Page;

  return {
    page,
    document: dom.window.document,
    wasClicked: () => clicked,
  };
}

describe("block element action", () => {
  test("removes all matching elements and leaves others untouched", async () => {
    const { page, document, wasClicked } = createPageDouble(
      `<div id="root">
        <a class="ad" href="https://example.com">1</a>
        <a class="ad" href="https://example.com">2</a>
        <p class="keep">keep</p>
      </div>`,
    );

    const actions: Action[] = [{ type: "block", data: { selector: ".ad" } }];

    await execActions(page, actions);

    expect(document.querySelectorAll(".ad").length).toBe(0);
    expect(document.querySelector(".keep")).not.toBeNull();
    expect(wasClicked()).toBe(false);
  });

  test("does not throw and removes nothing when the selector has no matches", async () => {
    const { page, document } = createPageDouble(
      `<div class="keep">keep</div>`,
    );

    const actions: Action[] = [
      { type: "block", data: { selector: ".missing" } },
    ];

    await expect(execActions(page, actions)).resolves.toBeUndefined();
    expect(document.querySelector(".keep")).not.toBeNull();
  });

  test("throws a clear error for invalid selector syntax", async () => {
    const { page } = createPageDouble(`<div class="keep">keep</div>`);

    const actions: Action[] = [
      { type: "block", data: { selector: ":::not-a-selector" } },
    ];

    await expect(execActions(page, actions)).rejects.toThrow(
      /invalid selector/,
    );
  });
});
