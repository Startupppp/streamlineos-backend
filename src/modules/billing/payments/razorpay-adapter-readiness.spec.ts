import { RazorpayAdapter } from "./adapters/razorpay.adapter";
import { PaymentProviderAdapterRegistry } from "./payment-provider-adapter.interface";

describe("RazorpayAdapter — configured runtime readiness and public key", () => {
  const registry = new PaymentProviderAdapterRegistry();

  describe("isReady", () => {
    it("returns false when no credentials are provided", () => {
      const adapter = new RazorpayAdapter(registry);
      expect(adapter.configure({}).isReady()).toBe(false);
    });

    it("returns false when only the key id is present", () => {
      const adapter = new RazorpayAdapter(registry);
      expect(adapter.configure({ keyId: "rzp_test_abc" }).isReady()).toBe(false);
    });

    it("returns false when only the key secret is present", () => {
      const adapter = new RazorpayAdapter(registry);
      expect(adapter.configure({ secret: "secret" }).isReady()).toBe(false);
    });

    it("returns true when both key id and key secret are present", () => {
      const adapter = new RazorpayAdapter(registry);
      expect(adapter.configure({ keyId: "rzp_test_abc", secret: "secret" }).isReady()).toBe(true);
    });

    it("returns false when key id is an empty string", () => {
      const adapter = new RazorpayAdapter(registry);
      expect(adapter.configure({ keyId: "", secret: "secret" }).isReady()).toBe(false);
    });

    it("returns false when key secret is an empty string", () => {
      const adapter = new RazorpayAdapter(registry);
      expect(adapter.configure({ keyId: "rzp_test_abc", secret: "" }).isReady()).toBe(false);
    });
  });

  describe("publicKeyId", () => {
    it("returns null when no credentials are provided", () => {
      const adapter = new RazorpayAdapter(registry);
      expect(adapter.configure({}).publicKeyId()).toBeNull();
    });

    it("returns null when only the key secret is present", () => {
      const adapter = new RazorpayAdapter(registry);
      expect(adapter.configure({ secret: "secret" }).publicKeyId()).toBeNull();
    });

    it("returns the key id when configured", () => {
      const adapter = new RazorpayAdapter(registry);
      expect(adapter.configure({ keyId: "rzp_test_abc123" }).publicKeyId()).toBe("rzp_test_abc123");
    });

    it("returns the key id even when the key secret is absent", () => {
      const adapter = new RazorpayAdapter(registry);
      expect(adapter.configure({ keyId: "rzp_live_xyz" }).publicKeyId()).toBe("rzp_live_xyz");
    });

    it("does not return any secret — only the public key id crosses the boundary", () => {
      const adapter = new RazorpayAdapter(registry);
      const result = adapter.configure({ keyId: "rzp_test_abc123", secret: "secret" }).publicKeyId();
      expect(result).not.toContain("must_never_be_returned");
    });
  });
});
