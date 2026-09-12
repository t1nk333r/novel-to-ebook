import { describe, expect, test } from "bun:test";
import { cleanLinkTitle } from "../ui/src/app/projects/view/lib/link-title";

/**
 * Chapter titles harvested from a catalog row.
 *
 * The fixtures are the real Webnovel shapes: the anchor for a row contains both
 * the chapter name and the relative timestamp, so the link's own text reads
 * "Characters (Updated for Vol. 15)7 years ago".
 */
describe("cleanLinkTitle", () => {
  test("drops a timestamp glued to the title", () => {
    expect(cleanLinkTitle("Characters (Updated for Vol. 15)7 years ago")).toBe(
      "Characters (Updated for Vol. 15)",
    );
  });

  test("drops a timestamp separated by a dash or space", () => {
    expect(cleanLinkTitle("Chapter 12 - 3 days ago")).toBe("Chapter 12");
    expect(cleanLinkTitle("Chapter 9  2 hours ago")).toBe("Chapter 9");
    expect(cleanLinkTitle("Chapter 4 (1 month ago)")).toBe("Chapter 4");
  });

  test("handles 'just now'", () => {
    expect(cleanLinkTitle("Chapter 2360 Just now")).toBe("Chapter 2360");
  });

  test("keeps a title that merely mentions time", () => {
    expect(cleanLinkTitle("Chapter 3: Three Days Ago In The Rain")).toBe(
      "Chapter 3: Three Days Ago In The Rain",
    );
    expect(cleanLinkTitle("Ago")).toBe("Ago");
    expect(cleanLinkTitle("Chapter 7: Days Gone By")).toBe("Chapter 7: Days Gone By");
  });

  test("leaves an ordinary title alone and normalises whitespace", () => {
    expect(cleanLinkTitle("Chapter 1: The Beginning of the End. Part 1/2")).toBe(
      "Chapter 1: The Beginning of the End. Part 1/2",
    );
    expect(cleanLinkTitle("  Chapter   5\n")).toBe("Chapter 5");
  });

  test("strips stacked metadata", () => {
    expect(cleanLinkTitle("Extra: Author's Note 2 days ago")).toBe(
      "Extra: Author's Note",
    );
  });
});
