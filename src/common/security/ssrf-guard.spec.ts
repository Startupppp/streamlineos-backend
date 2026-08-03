import { assertSafeWebhookUrl } from "./ssrf-guard";

describe("assertSafeWebhookUrl — SSRF guard", () => {
  it("allows a public HTTPS endpoint", () => {
    expect(() => assertSafeWebhookUrl("https://example.com/webhook")).not.toThrow();
  });

  it("allows a public HTTP endpoint on a non-private IP", () => {
    expect(() => assertSafeWebhookUrl("http://203.0.113.5/hook")).not.toThrow();
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
});
