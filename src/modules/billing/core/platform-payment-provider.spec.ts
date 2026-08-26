import { RazorpayService } from "./razorpay.service";
import {
  PLATFORM_PAYMENT_PROVIDER,
  type PlatformPaymentProvider,
} from "./platform-payment-provider";
import type { AppConfig } from "../../../config/env.validation";

function serviceWith(config: Partial<AppConfig>): RazorpayService {
  return new RazorpayService(config as AppConfig);
}

const CONFIGURED = {
  RAZORPAY_KEY_ID: "rzp_test_abc",
  RAZORPAY_KEY_SECRET: "secret",
  RAZORPAY_WEBHOOK_SECRET: "hook",
};

describe("RazorpayService as a PlatformPaymentProvider", () => {
  it("satisfies the interface, so a second provider can be substituted", () => {
    // The point of the extraction: the call sites depend on this shape and
    // nothing else, so ticket 02 adds an implementation rather than a branch.
    const provider: PlatformPaymentProvider = serviceWith(CONFIGURED);
    expect(provider.providerKey).toBe("razorpay");
  });

  it("reports configured only when it can actually charge", () => {
    expect(serviceWith(CONFIGURED).isConfigured()).toBe(true);
    expect(serviceWith({ RAZORPAY_KEY_ID: "rzp_test_abc" }).isConfigured()).toBe(false);
    expect(serviceWith({ RAZORPAY_KEY_SECRET: "secret" }).isConfigured()).toBe(false);
    expect(serviceWith({}).isConfigured()).toBe(false);
  });

  it("exposes the publishable key, and null rather than undefined when absent", () => {
    // The browser needs it to open checkout; null is the shape the API returns.
    expect(serviceWith(CONFIGURED).getPublishableKey()).toBe("rzp_test_abc");
    expect(serviceWith({}).getPublishableKey()).toBeNull();
  });

  describe("signature verification", () => {
    it("refuses when no secret is configured, rather than throwing", () => {
      const bare = serviceWith({});
      expect(bare.verifyPaymentSignature("order", "pay", "sig")).toBe(false);
      expect(bare.verifyWebhookSignature("{}", "sig")).toBe(false);
    });

    it("refuses a signature of the wrong length without throwing", () => {
      // timingSafeEqual throws on unequal lengths; a forged short signature must
      // be a false, not a 500.
      expect(serviceWith(CONFIGURED).verifyPaymentSignature("o", "p", "short")).toBe(false);
    });

    it("accepts a correctly computed payment signature", () => {
      const { createHmac } = require("node:crypto") as typeof import("node:crypto");
      const expected = createHmac("sha256", "secret").update("order_1|pay_1").digest("hex");
      expect(serviceWith(CONFIGURED).verifyPaymentSignature("order_1", "pay_1", expected)).toBe(true);
    });

    it("accepts a correctly computed webhook signature", () => {
      const { createHmac } = require("node:crypto") as typeof import("node:crypto");
      const body = '{"event":"payment.captured"}';
      const expected = createHmac("sha256", "hook").update(body).digest("hex");
      expect(serviceWith(CONFIGURED).verifyWebhookSignature(body, expected)).toBe(true);
    });

    it("rejects a signature computed with the wrong secret", () => {
      const { createHmac } = require("node:crypto") as typeof import("node:crypto");
      const forged = createHmac("sha256", "wrong").update("order_1|pay_1").digest("hex");
      expect(serviceWith(CONFIGURED).verifyPaymentSignature("order_1", "pay_1", forged)).toBe(false);
    });
  });

  it("has an injection token, because an interface does not survive to runtime", () => {
    expect(typeof PLATFORM_PAYMENT_PROVIDER).toBe("symbol");
  });
});
