import { checkWebhookUrl } from "./webhook-url-guard";

describe("checkWebhookUrl", () => {
  it("rejects a malformed url", async () => {
    await expect(checkWebhookUrl("not a url")).resolves.toEqual({
      allowed: false,
      reason: "invalid-url",
    });
  });

  it.each(["file:///etc/passwd", "gopher://example.com", "ftp://example.com"])(
    "rejects non-http scheme %s",
    async (url) => {
      await expect(checkWebhookUrl(url)).resolves.toEqual({
        allowed: false,
        reason: "unsupported-scheme",
      });
    },
  );

  it.each([
    ["loopback", "http://127.0.0.1/hook"],
    ["loopback alt", "http://127.10.20.30/hook"],
    ["cloud metadata", "http://169.254.169.254/latest/meta-data/"],
    ["private 10/8", "http://10.0.0.5/hook"],
    ["private 172.16/12", "http://172.20.1.1/hook"],
    ["private 192.168/16", "http://192.168.1.1/hook"],
    ["carrier-grade NAT", "http://100.64.0.1/hook"],
    ["this-network", "http://0.0.0.0/hook"],
    ["multicast", "http://239.1.1.1/hook"],
    ["ipv6 loopback", "http://[::1]/hook"],
    ["ipv6 link-local", "http://[fe80::1]/hook"],
    ["ipv6 unique-local", "http://[fd00::1]/hook"],
    ["ipv4-mapped loopback", "http://[::ffff:127.0.0.1]/hook"],
  ])("blocks %s", async (_label, url) => {
    await expect(checkWebhookUrl(url)).resolves.toEqual({
      allowed: false,
      reason: "blocked-address",
    });
  });

  it("allows a public literal address", async () => {
    await expect(checkWebhookUrl("https://93.184.216.34/hook")).resolves.toEqual({
      allowed: true,
    });
  });

  it("rejects a hostname that does not resolve", async () => {
    const result = await checkWebhookUrl(
      "https://webhook-guard-nonexistent.invalid/hook",
    );
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(["unresolvable-host", "blocked-address"]).toContain(result.reason);
    }
  });
});
