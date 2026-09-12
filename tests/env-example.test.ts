import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * `.env.example` is committed — it is the configuration contract, not a place
 * for values. A real credential pasted into it was one `git add -A` away from
 * the fork, which is how this file came to exist.
 */
const EXAMPLE = readFileSync(new URL("../.env.example", import.meta.url), "utf8");

const SECRET_NAME = /(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)S?$/i;

describe(".env.example", () => {
  test("keeps every credential empty", () => {
    const filled = EXAMPLE.split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .map((line) => line.trim())
      .filter((line) => line.includes("="))
      .map((line) => ({ name: line.slice(0, line.indexOf("=")), value: line.slice(line.indexOf("=") + 1).trim() }))
      .filter((entry) => SECRET_NAME.test(entry.name) && entry.value.length > 0);

    // Deliberately reports the variable *names* only: a failure message must not
    // echo the value that was pasted.
    expect(filled.map((entry) => entry.name)).toEqual([]);
  });

  test("still documents the variables that turn features on", () => {
    // The guard above is only useful while this file remains the real contract.
    for (const name of [
      "DATABASE_URL",
      "API_TOKEN",
      "MISTRAL_API_KEY",
      "OLLAMA_URL",
      "AI_PROVIDER",
    ]) {
      expect(EXAMPLE).toMatch(new RegExp(`^${name}=`, "m"));
    }
  });
});
