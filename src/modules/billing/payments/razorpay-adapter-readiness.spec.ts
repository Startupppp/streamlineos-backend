import { RazorpayAdapter } from "./adapters/razorpay.adapter";
import { PaymentProviderAdapterRegistry } from "./payment-provider-adapter.interface";

describe("RazorpayAdapter — isReady and publicKeyId", () => {
  const registry = new PaymentProviderAdapterRegistry();

  describe("isReady", () => {
    it("returns false when no credentials are provided", () => {
      const adapter = new RazorpayAdapter(registry);
      expect(adapter.isReady()).toBe(false);
    });

    it("returns false when only the key id is present", () => {
      const adapter = new RazorpayAdapter(registry, { RAZORPAY_KEY_ID: "rzp_test_abc" });
      expect(adapter.isReady()).toBe(false);
    });

    it("returns false when only the key secret is present", () => {
      const adapter = new RazorpayAdapter(registry, { RAZORPAY_KEY_SECRET: "secret" });
      expect(adapter.isReady()).toBe(false);
    });

    it("returns true when both key id and key secret are present", () => {
      const adapter = new RazorpayAdapter(registry, {
        RAZORPAY_KEY_ID: "rzp_test_abc",
        RAZORPAY_KEY_SECRET: "secret",
      });
      expect(adapter.isReady()).toBe(true);
    });

    it("returns false when key id is an empty string", () => {
      const adapter = new RazorpayAdapter(registry, {
        RAZORPAY_KEY_ID: "",
        RAZORPAY_KEY_SECRET: "secret",
      });
      expect(adapter.isReady()).toBe(false);
    });

    it("returns false when key secret is an empty string", () => {
      const adapter = new RazorpayAdapter(registry, {
        RAZORPAY_KEY_ID: "rzp_test_abc",
        RAZORPAY_KEY_SECRET: "",
      });
      expect(adapter.isReady()).toBe(false);
    });
  });

  describe("publicKeyId", () => {
    it("returns null when no credentials are provided", () => {
      const adapter = new RazorpayAdapter(registry);
      expect(adapter.publicKeyId()).toBeNull();
    });

    it("returns null when only the key secret is present", () => {
      const adapter = new RazorpayAdapter(registry, { RAZORPAY_KEY_SECRET: "secret" });
      expect(adapter.publicKeyId()).toBeNull();
    });

    it("returns the key id when configured", () => {
      const adapter = new RazorpayAdapter(registry, {
        RAZORPAY_KEY_ID: "rzp_test_abc123",
        RAZORPAY_KEY_SECRET: "secret",
      });
      expect(adapter.publicKeyId()).toBe("rzp_test_abc123");
    });

    it("returns the key id even when the key secret is absent", () => {
      const adapter = new RazorpayAdapter(registry, { RAZORPAY_KEY_ID: "rzp_live_xyz" });
      expect(adapter.publicKeyId()).toBe("rzp_live_xyz");
    });

    it("does not return any secret — only the public key id crosses the boundary", () => {
      const adapter = new RazorpayAdapter(registry, {
        RAZORPAY_KEY_ID: "rzp_test_public",
        RAZORPAY_KEY_SECRET: "must_never_be_returned",
      });
      const result = adapter.publicKeyId();
      expect(result).not.toContain("must_never_be_returned");
    });
  });
});
