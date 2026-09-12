import { describe, expect, test } from "bun:test";
import {
  assertSafeOutboundUrl,
  isAllowedOutboundUrl,
  isPublicIp,
} from "../src/lib/network-policy";
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

describe("isAllowedOutboundUrl", () => {
  // The EPUB generator calls this for every image URL in stored chapter
  // content, which is scraped from pages the operator does not control.
  test("allows ordinary public http(s) URLs", () => {
    expect(isAllowedOutboundUrl("https://example.com/cover.jpg")).toBe(true);
    expect(isAllowedOutboundUrl("http://example.com/a.png")).toBe(true);
    expect(isAllowedOutboundUrl("https://example.com:8443/a.png?v=2")).toBe(true);
  });

  test("refuses schemes that are not http(s)", () => {
    expect(isAllowedOutboundUrl("file:///etc/passwd")).toBe(false);
    expect(isAllowedOutboundUrl("file://localhost/etc/hostname")).toBe(false);
    expect(isAllowedOutboundUrl("data:image/png;base64,AAAA")).toBe(false);
    expect(isAllowedOutboundUrl("ftp://example.com/a.png")).toBe(false);
  });

  test("refuses loopback, private, and link-local hosts", () => {
    expect(isAllowedOutboundUrl("http://127.0.0.1:3013/api/library")).toBe(false);
    expect(isAllowedOutboundUrl("http://localhost/a.png")).toBe(false);
    expect(isAllowedOutboundUrl("http://metadata.localhost/a")).toBe(false);
    expect(isAllowedOutboundUrl("http://169.254.169.254/latest/meta-data/")).toBe(false);
    expect(isAllowedOutboundUrl("http://10.0.0.5/a.png")).toBe(false);
    expect(isAllowedOutboundUrl("http://192.168.1.10/a.png")).toBe(false);
    expect(isAllowedOutboundUrl("http://[::1]/a.png")).toBe(false);
  });

  test("refuses embedded credentials and unparseable input", () => {
    expect(isAllowedOutboundUrl("https://user:pass@example.com/a.png")).toBe(false);
    expect(isAllowedOutboundUrl("https://user@example.com/a.png")).toBe(false);
    expect(isAllowedOutboundUrl("//example.com/a.png")).toBe(false);
    expect(isAllowedOutboundUrl("not a url")).toBe(false);
    expect(isAllowedOutboundUrl("")).toBe(false);
  });

  test("agrees with the async guard on the checks it can make", async () => {
    for (const url of ["file:///etc/passwd", "http://127.0.0.1/a", "https://u:p@example.com/a"]) {
      expect(isAllowedOutboundUrl(url)).toBe(false);
      await expect(assertSafeOutboundUrl(url)).rejects.toThrow();
    }
  });
});
