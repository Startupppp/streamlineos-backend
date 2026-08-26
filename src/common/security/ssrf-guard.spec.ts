jest.mock("node:dns/promises", () => ({ lookup: jest.fn() }));

import { assertSafeWebhookUrl, checkWebhookUrl } from "./ssrf-guard";

interface ResolvedAddress {
  address: string;
  family: number;
}

const { lookup: mockLookup } = jest.requireMock<{
  lookup: jest.Mock<Promise<ResolvedAddress[]>, [string, { all: true }]>;
}>("node:dns/promises");

describe("assertSafeWebhookUrl — SSRF guard", () => {
  it("allows a public HTTPS endpoint", () => {
    expect(() => assertSafeWebhookUrl("https://example.com/webhook")).not.toThrow();
  });

  it("allows a public HTTP endpoint on a non-private IP", () => {
    expect(() => assertSafeWebhookUrl("http://8.8.8.8/hook")).not.toThrow();
  });

  it("blocks TEST-NET-2 (198.51.100.0/24, RFC 5737)", () => {
    expect(() => assertSafeWebhookUrl("http://198.51.100.5/hook")).toThrow(
      "SSRF: private/internal URLs are blocked",
    );
  });

  it("blocks TEST-NET-3 (203.0.113.0/24, RFC 5737)", () => {
    expect(() => assertSafeWebhookUrl("http://203.0.113.5/hook")).toThrow(
      "SSRF: private/internal URLs are blocked",
    );
  });

  it("blocks loopback 127.0.0.1", () => {
    expect(() => assertSafeWebhookUrl("http://127.0.0.1/steal")).toThrow(
      "SSRF: private/internal URLs are blocked",
    );
  });

  it("blocks localhost", () => {
    expect(() => assertSafeWebhookUrl("http://localhost/steal")).toThrow(
      "SSRF: private/internal URLs are blocked",
    );
  });

  it("blocks LOCALHOST (case-insensitive)", () => {
    expect(() => assertSafeWebhookUrl("http://LOCALHOST/steal")).toThrow(
      "SSRF: private/internal URLs are blocked",
    );
  });

  it("blocks private class-A (10.x.x.x)", () => {
    expect(() => assertSafeWebhookUrl("http://10.0.0.1/internal")).toThrow(
      "SSRF: private/internal URLs are blocked",
    );
  });

  it("blocks private class-A upper range (10.255.255.255)", () => {
    expect(() => assertSafeWebhookUrl("http://10.255.255.255/internal")).toThrow(
      "SSRF: private/internal URLs are blocked",
    );
  });

  it("blocks private class-B lower bound (172.16.0.1)", () => {
    expect(() => assertSafeWebhookUrl("http://172.16.0.1/internal")).toThrow(
      "SSRF: private/internal URLs are blocked",
    );
  });

  it("blocks private class-B upper bound (172.31.255.255)", () => {
    expect(() => assertSafeWebhookUrl("http://172.31.255.255/internal")).toThrow(
      "SSRF: private/internal URLs are blocked",
    );
  });

  it("does not block 172.15.x.x (just below private class-B range)", () => {
    expect(() => assertSafeWebhookUrl("http://172.15.0.1/external")).not.toThrow();
  });

  it("does not block 172.32.x.x (just above private class-B range)", () => {
    expect(() => assertSafeWebhookUrl("http://172.32.0.1/external")).not.toThrow();
  });

  it("blocks private class-C (192.168.x.x)", () => {
    expect(() => assertSafeWebhookUrl("http://192.168.1.1/internal")).toThrow(
      "SSRF: private/internal URLs are blocked",
    );
  });

  it("throws on an unparseable URL", () => {
    expect(() => assertSafeWebhookUrl("not-a-url")).toThrow("Invalid URL");
  });

  it("throws on an empty string", () => {
    expect(() => assertSafeWebhookUrl("")).toThrow("Invalid URL");
  });

  it("blocks a localhost subdomain", () => {
    expect(() => assertSafeWebhookUrl("http://api.localhost/steal")).toThrow(
      "SSRF: private/internal URLs are blocked",
    );
  });
});

const BLOCKED_ADDRESS_FORMS: readonly [label: string, url: string][] = [
  ["unspecified 0.0.0.0/8", "http://0.0.0.0/x"],
  ["loopback 127.0.0.0/8", "http://127.0.0.1/x"],
  ["RFC-1918 class A", "http://10.0.0.1/x"],
  ["RFC-1918 class B lower bound", "http://172.16.0.1/x"],
  ["RFC-1918 class B upper bound", "http://172.31.255.255/x"],
  ["RFC-1918 class C", "http://192.168.1.1/x"],
  ["link-local / cloud metadata", "http://169.254.169.254/x"],
  ["CGNAT lower bound (RFC 6598)", "http://100.64.0.1/x"],
  ["CGNAT upper bound (RFC 6598)", "http://100.127.255.255/x"],
  ["TEST-NET-1 (RFC 5737)", "http://192.0.2.1/x"],
  ["TEST-NET-2 (RFC 5737)", "http://198.51.100.5/x"],
  ["TEST-NET-3 (RFC 5737)", "http://203.0.113.5/x"],
  ["reserved 240.0.0.0/4", "http://240.0.0.1/x"],
  ["broadcast 255.255.255.255", "http://255.255.255.255/x"],
  ["multicast 224.0.0.0/4", "http://224.0.0.1/x"],
  ["IPv6 loopback", "http://[::1]/x"],
  ["IPv6 loopback, expanded spelling", "http://[0:0:0:0:0:0:0:1]/x"],
  ["IPv6 unspecified", "http://[::]/x"],
  ["IPv6 unspecified, expanded spelling", "http://[0:0:0:0:0:0:0:0]/x"],
  ["IPv6 link-local fe80::/10", "http://[fe80::1]/x"],
  ["IPv6 unique-local fc00::/8", "http://[fc00::1]/x"],
  ["IPv6 unique-local fd00::/8", "http://[fd12:3456::1]/x"],
  ["IPv6 multicast ff00::/8", "http://[ff02::1]/x"],
  ["IPv4-mapped, dotted spelling", "http://[::ffff:127.0.0.1]/x"],
  ["IPv4-mapped, packed spelling", "http://[::ffff:7f00:1]/x"],
  ["IPv4-mapped private, packed spelling", "http://[::ffff:c0a8:0101]/x"],
  ["IPv4-mapped metadata, packed spelling", "http://[::ffff:a9fe:a9fe]/x"],
];

const ALLOWED_ADDRESS_FORMS: readonly [label: string, url: string][] = [
  ["public IPv4", "http://8.8.8.8/x"],
  ["just below RFC-1918 class B", "http://172.15.0.1/x"],
  ["just above RFC-1918 class B", "http://172.32.0.1/x"],
  ["just below CGNAT", "http://100.63.255.255/x"],
  ["just above CGNAT", "http://100.128.0.1/x"],
  ["public IPv6", "http://[2001:4860:4860::8888]/x"],
  ["IPv4-mapped public address", "http://[::ffff:8.8.8.8]/x"],
];

describe("checkWebhookUrl — address forms the retired inventory guard blocked", () => {
  beforeEach(() => {
    mockLookup.mockReset();
  });

  it.each(BLOCKED_ADDRESS_FORMS)("blocks %s", async (_label, url) => {
    await expect(checkWebhookUrl(url)).resolves.toEqual({
      allowed: false,
      reason: "blocked-address",
    });
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it.each(ALLOWED_ADDRESS_FORMS)("allows %s", async (_label, url) => {
    await expect(checkWebhookUrl(url)).resolves.toEqual({ allowed: true });
  });

  it("rejects an IPv6 zone id, which cannot survive URL parsing", async () => {
    await expect(checkWebhookUrl("http://[fe80::1%25eth0]/x")).resolves.toEqual({
      allowed: false,
      reason: "invalid-url",
    });
  });

  it("blocks a hostname that resolves to a blocked address", async () => {
    mockLookup.mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);
    await expect(checkWebhookUrl("http://metadata.example.com/x")).resolves.toEqual({
      allowed: false,
      reason: "blocked-address",
    });
  });

  it("blocks a hostname whose second resolved address is internal", async () => {
    mockLookup.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ]);
    await expect(checkWebhookUrl("http://rebind.example.com/x")).resolves.toEqual({
      allowed: false,
      reason: "blocked-address",
    });
  });

  it("rejects a hostname that does not resolve", async () => {
    mockLookup.mockRejectedValue(new Error("ENOTFOUND"));
    await expect(checkWebhookUrl("http://nope.example.com/x")).resolves.toEqual({
      allowed: false,
      reason: "unresolvable-host",
    });
  });

  it("rejects a non-http scheme", async () => {
    await expect(checkWebhookUrl("file:///etc/passwd")).resolves.toEqual({
      allowed: false,
      reason: "unsupported-scheme",
    });
  });
});
