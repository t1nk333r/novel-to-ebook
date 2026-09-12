import { describe, expect, test } from "bun:test";
import { stripSiteChrome } from "../src/app/projects/utils";

/**
 * Site furniture that travels with the chapter container.
 *
 * The fixture mirrors Webnovel: `div.cha-content` holds the prose in
 * `div.cha-words`, the author's note in `div.m-thou` ("CREATORS' THOUGHTS") and
 * a share/comment strip in `div.user-links-wrap`. Picking the container used to
 * drag all three into the book.
 */
const WEBNOVEL_CONTENT = `
<div class="cha-content">
  <div class="cha-words _font_31586142793028464">
    <p>December 31st, 1999. The whole world stands upon the precipice.</p>
    <p>The clock ticks down towards midnight.</p>
  </div>
  <div class="m-thou mb24 mt40">
    <b>CREATORS' THOUGHTS</b>
    <a href="/profile/123">Einlion</a>
    <p>Strawpoll for first world: https://www.strawpoll.me/16512366</p>
  </div>
  <div class="user-links-wrap mb48 pr tac fs0 pb16">
    <a href="#comment">498 comments</a>
  </div>
</div>`;

describe("stripSiteChrome", () => {
  test("removes the author note and the share strip, keeps the prose", () => {
    const { html, removed } = stripSiteChrome(WEBNOVEL_CONTENT);

    expect(removed).toBe(2);
    expect(html).not.toContain("CREATORS' THOUGHTS");
    expect(html).not.toContain("strawpoll");
    expect(html).not.toContain("498 comments");
    expect(html).toContain("precipice");
    expect(html).toContain("midnight");
  });

  test("keeps the chapter's own container intact", () => {
    const { html } = stripSiteChrome(WEBNOVEL_CONTENT);

    expect(html).toContain("cha-words");
    expect(html).toContain("cha-content");
  });

  test("removes nested furniture without touching siblings", () => {
    const { html, removed } = stripSiteChrome(
      `<div class="body"><p>prose</p><div><span class="author-note">note</span></div><p>more</p></div>`,
    );

    expect(removed).toBe(1);
    expect(html).not.toContain("note</span>");
    expect(html).toContain("prose");
    expect(html).toContain("more");
  });

  test("matches tokens, not substrings", () => {
    // "commentary" and "sharing" must survive: they are prose, not widgets.
    const { html, removed } = stripSiteChrome(
      `<div class="content"><p class="commentary">The commentary on this chapter</p><p>about sharing bread</p></div>`,
    );

    expect(removed).toBe(0);
    expect(html).toContain("commentary");
    expect(html).toContain("sharing bread");
  });

  test("leaves an ordinary chapter untouched", () => {
    const plain = `<div class="chapter"><h2>Chapter 5</h2><p>Some text.</p></div>`;
    const { html, removed } = stripSiteChrome(plain);

    expect(removed).toBe(0);
    expect(html).toContain("Some text.");
  });

  test("keeps the chapter when its own container matches a chrome pattern", () => {
    // Webnovel tags the chapter container with `para-comment-allowed` (it enables
    // per-paragraph comment threads). The comments pattern matched that token and
    // deleted the entire chapter: 1,368 words in, nothing out. Selecting the
    // container — which the picker offers — is enough to hit this.
    const { html, removed } = stripSiteChrome(`
<div class="chapter_content j_chapter_31586142793028464 para-comment-allowed">
  <div class="cha-words">
    <p>December 31st, 1999. The whole world stands upon the precipice of a new millennia,
    while snow falls over a city that does not yet know what is coming for it.</p>
    <p>He woke to the sound of the clock and the smell of smoke from the chimney below.</p>
  </div>
  <div class="m-thou">CREATORS' THOUGHTS</div>
</div>`);

    expect(html).toContain("precipice");
    expect(html).toContain("smell of smoke");
    expect(html).not.toContain("CREATORS' THOUGHTS");
    // Only the note is furniture here.
    expect(removed).toBe(1);
  });

  test("can empty content entirely when every block is furniture", () => {
    const { html, removed } = stripSiteChrome(
      `<div class="cha-content"><div class="m-thou">note</div></div>`,
    );

    expect(removed).toBe(1);
    // The caller's existing empty-content check turns this into a clean error.
    expect(html.replace(/<[^>]*>/g, "").trim()).toBe("");
  });
});
