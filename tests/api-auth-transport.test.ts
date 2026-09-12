import { describe, expect, test } from "bun:test";
import { apiAuthHeader, isApiRequest } from "../ui/src/lib/api-auth";

const ORIGIN = "http://localhost:3000";
const TOKEN = "t0ken-value";

describe("apiAuthHeader", () => {
  test("attaches the bearer header to a relative API path", () => {
    expect(apiAuthHeader("/api/library/list", ORIGIN, TOKEN)).toEqual({
      Authorization: `Bearer ${TOKEN}`,
    });
  });

  test("attaches the bearer header to an absolute same-origin API url", () => {
    expect(
      apiAuthHeader("http://localhost:3000/api/library/list", ORIGIN, TOKEN),
    ).toEqual({ Authorization: `Bearer ${TOKEN}` });
  });

  test("never leaks the token to a cross-origin url that looks like the API", () => {
    expect(apiAuthHeader("https://evil.example/api/x", ORIGIN, TOKEN)).toBe(
      undefined,
    );
    expect(
      apiAuthHeader("http://localhost:4000/api/x", ORIGIN, TOKEN),
    ).toBe(undefined);
  });

  test("skips same-origin paths outside the API", () => {
    expect(apiAuthHeader("/assets/app.js", ORIGIN, TOKEN)).toBe(undefined);
    expect(apiAuthHeader("/index.html", ORIGIN, TOKEN)).toBe(undefined);
  });

  test("skips a path that only shares the API prefix's characters", () => {
    expect(apiAuthHeader("/apiary/x", ORIGIN, TOKEN)).toBe(undefined);
  });

  test("sends nothing when no token is stored", () => {
    for (const token of [null, undefined, "", "   "]) {
      expect(apiAuthHeader("/api/library/list", ORIGIN, token)).toBe(undefined);
    }
  });

  test("trims a padded token", () => {
    expect(apiAuthHeader("/api/library/list", ORIGIN, `  ${TOKEN}\n`)).toEqual({
      Authorization: `Bearer ${TOKEN}`,
    });
  });
});

describe("isApiRequest", () => {
  test("matches the bare API root and its children only", () => {
    expect(isApiRequest("/api", ORIGIN)).toBe(true);
    expect(isApiRequest("/api/projects/1", ORIGIN)).toBe(true);
    expect(isApiRequest("/", ORIGIN)).toBe(false);
  });

  test("returns false instead of throwing on an unparseable url", () => {
    expect(isApiRequest("http://[", ORIGIN)).toBe(false);
  });
});
