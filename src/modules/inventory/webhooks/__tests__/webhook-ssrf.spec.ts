import { validateWebhookUrl } from "../webhooks.service";

describe("validateWebhookUrl", () => {
  describe("valid public HTTPS URLs", () => {
    it("returns null for a valid https public URL", () => {
      expect(validateWebhookUrl("https://example.com/hook", true)).toBeNull();
    });

    it("returns null for https URL with path and query", () => {
      expect(validateWebhookUrl("https://hooks.example.org/inventory/events?token=abc", true)).toBeNull();
    });

    it("returns null for http URL in non-production mode", () => {
      expect(validateWebhookUrl("http://example.com/hook", false)).toBeNull();
    });
  });

  describe("rejects private/loopback addresses", () => {
    it("returns error for localhost", () => {
      expect(validateWebhookUrl("http://localhost:3000/hook", false)).not.toBeNull();
    });

    it("returns error for 127.0.0.1", () => {
      expect(validateWebhookUrl("https://127.0.0.1/hook", true)).not.toBeNull();
    });

    it("returns error for 192.168.x.x (private class C)", () => {
      expect(validateWebhookUrl("https://192.168.1.1/hook", true)).not.toBeNull();
    });

    it("returns error for 10.0.0.1 (private class A)", () => {
      expect(validateWebhookUrl("https://10.0.0.1/hook", true)).not.toBeNull();
    });

    it("returns error for 172.16.0.1 (private class B)", () => {
      expect(validateWebhookUrl("https://172.16.0.1/hook", true)).not.toBeNull();
    });

    it("returns error for 169.254.169.254 (AWS metadata endpoint)", () => {
      expect(validateWebhookUrl("https://169.254.169.254/hook", true)).not.toBeNull();
    });
  });

  describe("enforces HTTPS in production", () => {
    it("returns error for http URL in production mode", () => {
      expect(validateWebhookUrl("http://example.com/hook", true)).not.toBeNull();
    });

    it("returns null for https URL in production mode", () => {
      expect(validateWebhookUrl("https://example.com/hook", true)).toBeNull();
    });
  });

  describe("return type is a descriptive error string", () => {
    it("returns a non-empty string for localhost", () => {
      const err = validateWebhookUrl("http://localhost/hook", false);
      expect(typeof err).toBe("string");
      expect((err as string).length).toBeGreaterThan(0);
    });

    it("returns a non-empty string for http in production", () => {
      const err = validateWebhookUrl("http://example.com/hook", true);
      expect(typeof err).toBe("string");
      expect((err as string).length).toBeGreaterThan(0);
    });
  });
});
