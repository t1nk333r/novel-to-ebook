import { describe, expect, test } from "bun:test";
import { isPublicIp, assertSafeOutboundUrl } from "../src/lib/network-policy";
import { resolveExportDestination } from "../src/lib/export-path";
import { resolveServerConfig } from "../src/lib/auth";

describe("security boundaries", () => {
  test("rejects private and metadata addresses", () => {
    expect(isPublicIp("127.0.0.1")).toBe(false);
    expect(isPublicIp("169.254.169.254")).toBe(false);
    expect(isPublicIp("8.8.8.8")).toBe(true);
  });

  test("rejects non-http URLs", async () => {
    await expect(assertSafeOutboundUrl("file:///etc/passwd")).rejects.toThrow();
  });

  test("confines export destinations beneath the data root", async () => {
    const destination = await resolveExportDestination("/tmp/storvi-test", "Novel", "exports");
    expect(destination.key).toBe("exports/Novel.epub");
    await expect(resolveExportDestination("/tmp/storvi-test", "Novel", "../escape")).rejects.toThrow();
  });

  test("loopback binds need no token", () => {
    const config = resolveServerConfig({ HOST: "127.0.0.1" });
    expect(config.remote).toBe(false);
    expect(config.insecureBind).toBe(false);
  });

  test("remote binds still require a token by default", () => {
    expect(() => resolveServerConfig({ HOST: "0.0.0.0" })).toThrow(/API_TOKEN is required/);
    expect(() => resolveServerConfig({ HOST: "0.0.0.0", ALLOW_INSECURE_BIND: "0" })).toThrow(
      /API_TOKEN is required/,
    );
  });

  test("ALLOW_INSECURE_BIND permits a tokenless remote bind", () => {
    const config = resolveServerConfig({ HOST: "0.0.0.0", ALLOW_INSECURE_BIND: "1" });
    expect(config.remote).toBe(true);
    expect(config.insecureBind).toBe(true);
    expect(config.apiToken).toBeUndefined();
  });

  test("ALLOW_INSECURE_BIND does not suppress a token that is set", () => {
    const config = resolveServerConfig({
      HOST: "0.0.0.0",
      ALLOW_INSECURE_BIND: "true",
      API_TOKEN: "configured-token",
    });
    expect(config.apiToken).toBe("configured-token");
    expect(config.insecureBind).toBe(true);
  });
});
