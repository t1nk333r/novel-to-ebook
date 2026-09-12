import { describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import {
  findChapterTitle,
  findDocumentChapterTitle,
} from "../src/app/projects/utils";

/**
 * Chapter-title selection.
 *
 * The fixture mirrors Webnovel's actual structure, which is what the previous
 * heuristic got wrong: the extracted content block opens with publisher chrome
 * (an author's note whose bold text reads "CREATORS' THOUGHTS Einlion"), while
 * the chapter's real title is an <h1> in the page document, outside the content
 * selector.
 */
const WEBNOVEL_PAGE = `<html><body>
  <div class="m-detail">
    <h1 class="dib mb0 fw700 fs24">Chapter 1: The Beginning of the End. Part 1/2</h1>
    <div class="cha-content">
      <b>CREATORS' THOUGHTS</b><a href="/profile">Einlion</a>
      <p>December 31st, 1999. The whole world stands upon the precipice.</p>
      <p>The clock ticks down towards midnight.</p>
    </div>
  </div>
</body></html>`;

const doc = (html: string) => new JSDOM(html).window.document;

describe("findDocumentChapterTitle", () => {
  test("picks the page heading that reads like a chapter title", () => {
    const { hinted, first } = findDocumentChapterTitle(doc(WEBNOVEL_PAGE));

    expect(hinted?.title).toBe("Chapter 1: The Beginning of the End. Part 1/2");
    expect(first?.title).toBe(hinted?.title);
    expect(hinted?.titleSelector).toBeTruthy();
  });

  test("separates a hinted heading from a mere first heading", () => {
    const { hinted, first } = findDocumentChapterTitle(
      doc(`<html><body><h1>MyNovelSite</h1><h2>Epilogue</h2></body></html>`),
    );

    // "Epilogue" reads like a chapter marker, the site name does not.
    expect(hinted?.title).toBe("Epilogue");
    expect(first?.title).toBe("MyNovelSite");
  });

  test("reports nothing when the page has no headings", () => {
    const { hinted, first } = findDocumentChapterTitle(
      doc(`<html><body><p>prose only</p></body></html>`),
    );

    expect(hinted).toBeNull();
    expect(first).toBeNull();
  });

  test("ignores absurdly long candidates", () => {
    const { hinted, first } = findDocumentChapterTitle(
      doc(`<html><body><h1>${"x".repeat(200)}</h1></body></html>`),
    );

    expect(hinted).toBeNull();
    expect(first).toBeNull();
  });

  test("reads the page heading, not the publisher chrome", () => {
    const { first } = findDocumentChapterTitle(doc(WEBNOVEL_PAGE));

    expect(first?.title).not.toContain("CREATORS' THOUGHTS");
  });
});

describe("findChapterTitle (inside the extracted block)", () => {
  test("a heading outranks bold text, whatever the tag order", () => {
    // Sorting candidates alphabetically put `b` before `h2`, so emphasis won.
    const title = findChapterTitle(
      doc(`<div><b>Advertisement</b><h2>Chapter 7: The Long Road</h2><p>body</p></div>`),
    );

    expect(title.title).toBe("Chapter 7: The Long Road");
  });

  test("ranks headings by level", () => {
    const title = findChapterTitle(
      doc(`<div><h3>Third</h3><h1>First</h1><p>body</p></div>`),
    );

    expect(title.title).toBe("First");
  });

  test("falls back to bold text when there is no heading", () => {
    const title = findChapterTitle(doc(`<div><b>Only Marked Text</b><p>body</p></div>`));

    expect(title.title).toBe("Only Marked Text");
  });

  test("still reports the publisher chrome when the block is all there is", () => {
    // Documents why the page-level lookup exists: the block alone yields the
    // author's note, which is what used to become the chapter title.
    const title = findChapterTitle(
      doc(`<div class="cha-content">
        <b>CREATORS' THOUGHTS</b><a href="/profile">Einlion</a>
        <p>December 31st, 1999. The whole world stands upon the precipice.</p>
      </div>`),
    );

    expect(title.title).toContain("CREATORS' THOUGHTS");
  });
});
