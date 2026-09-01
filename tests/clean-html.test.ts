import { describe, expect, test } from "bun:test";
import { cleanHTML } from "../src/lib/utils";

describe("cleanHTML", () => {
  test("keeps supported novel markup and removes executable content", () => {
    const result = cleanHTML(
      '<h2>Chapter 1</h2><script>alert(1)</script><p onclick="bad()">Text</p>',
    );

    expect(result).toBe("<h2>Chapter 1</h2><p>Text</p>");
  });

  test("keeps only approved alignment styles", () => {
    const result = cleanHTML(
      '<p style="text-align:center;color:red">Centered</p>',
    );

    expect(result).toBe('<p style="text-align:center">Centered</p>');
  });
});
