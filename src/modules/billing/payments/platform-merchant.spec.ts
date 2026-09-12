import { PaymentProviderAdapterRegistry } from "./payment-provider-adapter.interface";
import { FakeProviderAdapter } from "./testing/fake-provider-adapter";
import { PlatformMerchantService } from "./platform-merchant.service";

function makeRegistry(key = "razorpay"): PaymentProviderAdapterRegistry {
  const registry = new PaymentProviderAdapterRegistry();
  registry.register(new FakeProviderAdapter(key));
  return registry;
}

function makeService(
  config: { RAZORPAY_KEY_ID?: string; RAZORPAY_KEY_SECRET?: string; RAZORPAY_WEBHOOK_SECRET?: string } | undefined,
  registry?: PaymentProviderAdapterRegistry,
): PlatformMerchantService {
  return new PlatformMerchantService(registry ?? makeRegistry(), config as never);
}

describe("PlatformMerchantService", () => {
  describe("environment()", () => {
    it("returns test for rzp_test_ prefixed key", () => {
      const svc = makeService({ RAZORPAY_KEY_ID: "rzp_test_FAKE", RAZORPAY_KEY_SECRET: "fake_secret" });
      expect(svc.environment()).toBe("test");
    });

    it("returns live for rzp_live_ prefixed key", () => {
      const svc = makeService({ RAZORPAY_KEY_ID: "rzp_live_FAKE", RAZORPAY_KEY_SECRET: "fake_secret" });
      expect(svc.environment()).toBe("live");
    });

    it("returns null when keyId is absent", () => {
      const svc = makeService({ RAZORPAY_KEY_SECRET: "fake_secret" });
      expect(svc.environment()).toBeNull();
    });

    it("returns null for an unrecognised key prefix — never defaults to live", () => {
      const svc = makeService({ RAZORPAY_KEY_ID: "unknown_prefix_key", RAZORPAY_KEY_SECRET: "fake_secret" });
      expect(svc.environment()).toBeNull();
    });
  });

  describe("resolve()", () => {
    it("returns a provider facade when credentials are fully set with a recognised prefix", () => {
      const svc = makeService({ RAZORPAY_KEY_ID: "rzp_test_FAKE", RAZORPAY_KEY_SECRET: "fake_secret" });
      expect(svc.resolve()).toBeDefined();
    });

    it("returns undefined when keyId is absent", () => {
      const svc = makeService({ RAZORPAY_KEY_SECRET: "fake_secret" });
      expect(svc.resolve()).toBeUndefined();
    });

    it("returns undefined when secret is absent", () => {
      const svc = makeService({ RAZORPAY_KEY_ID: "rzp_test_FAKE" });
      expect(svc.resolve()).toBeUndefined();
    });

    it("returns undefined when both credentials are absent", () => {
      const svc = makeService({});
      expect(svc.resolve()).toBeUndefined();
    });

    it("returns undefined when no razorpay adapter is registered", () => {
      const emptyRegistry = new PaymentProviderAdapterRegistry();
      const svc = makeService(
        { RAZORPAY_KEY_ID: "rzp_test_FAKE", RAZORPAY_KEY_SECRET: "fake_secret" },
        emptyRegistry,
      );
      expect(svc.resolve()).toBeUndefined();
    });

    it("returns undefined when key prefix is unrecognised — never silently activates live mode", () => {
      const svc = makeService({ RAZORPAY_KEY_ID: "badprefix_FAKE", RAZORPAY_KEY_SECRET: "fake_secret" });
      expect(svc.resolve()).toBeUndefined();
    });

    it("does not touch the database — no Db injection required", () => {
      const svc = makeService({ RAZORPAY_KEY_ID: "rzp_test_FAKE", RAZORPAY_KEY_SECRET: "fake_secret" });
      expect(() => svc.resolve()).not.toThrow();
    });
  });

  describe("readiness()", () => {
    it("reports no_credentials when both keyId and secret are absent", () => {
      const svc = makeService({});
      const r = svc.readiness();
      expect(r.configured).toBe(false);
      expect(r.unavailableReason).toBe("no_credentials");
    });

    it("reports incomplete_credentials when only keyId is present", () => {
      const svc = makeService({ RAZORPAY_KEY_ID: "rzp_test_FAKE" });
      const r = svc.readiness();
      expect(r.configured).toBe(false);
      expect(r.unavailableReason).toBe("incomplete_credentials");
    });

    it("reports incomplete_credentials when only secret is present", () => {
      const svc = makeService({ RAZORPAY_KEY_SECRET: "fake_secret" });
      const r = svc.readiness();
      expect(r.configured).toBe(false);
      expect(r.unavailableReason).toBe("incomplete_credentials");
    });

    it("reports incomplete_credentials when key prefix is unrecognised (resolve refuses the key)", () => {
      const svc = makeService({ RAZORPAY_KEY_ID: "badprefix_FAKE", RAZORPAY_KEY_SECRET: "fake_secret" });
      const r = svc.readiness();
      expect(r.configured).toBe(false);
      expect(r.unavailableReason).toBe("incomplete_credentials");
      expect(r.environment).toBeNull();
    });

    it("reports unsupported_provider when no razorpay adapter is registered", () => {
      const emptyRegistry = new PaymentProviderAdapterRegistry();
      const svc = makeService(
        { RAZORPAY_KEY_ID: "rzp_test_FAKE", RAZORPAY_KEY_SECRET: "fake_secret" },
        emptyRegistry,
      );
      const r = svc.readiness();
      expect(r.configured).toBe(false);
      expect(r.unavailableReason).toBe("unsupported_provider");
    });

    it("reports configured:true when adapter exists and credentials are complete with recognised prefix", () => {
      const svc = makeService({
        RAZORPAY_KEY_ID: "rzp_test_FAKE",
        RAZORPAY_KEY_SECRET: "fake_secret",
        RAZORPAY_WEBHOOK_SECRET: "wh_secret",
      });
      const r = svc.readiness();
      expect(r.configured).toBe(true);
      expect(r.unavailableReason).toBeNull();
      expect(r.publicKeyId).toBe("rzp_test_FAKE");
      expect(r.environment).toBe("test");
      expect(r.webhookConfigured).toBe(true);
    });

    it("reports webhookConfigured:false when webhook secret is absent", () => {
      const svc = makeService({ RAZORPAY_KEY_ID: "rzp_test_FAKE", RAZORPAY_KEY_SECRET: "fake_secret" });
      expect(svc.readiness().webhookConfigured).toBe(false);
    });

    it("does not include any secret material in readiness output", () => {
      const svc = makeService({
        RAZORPAY_KEY_ID: "rzp_test_FAKE",
        RAZORPAY_KEY_SECRET: "SUPER_SECRET_VALUE",
        RAZORPAY_WEBHOOK_SECRET: "WEBHOOK_SECRET_VALUE",
      });
      const serialized = JSON.stringify(svc.readiness());
      expect(serialized).not.toContain("SUPER_SECRET_VALUE");
      expect(serialized).not.toContain("WEBHOOK_SECRET_VALUE");
    });

    it("reports environment:live for a live-prefixed key", () => {
      const svc = makeService({ RAZORPAY_KEY_ID: "rzp_live_FAKE", RAZORPAY_KEY_SECRET: "fake_secret" });
      expect(svc.readiness().environment).toBe("live");
    });

    it("unavailableReason is null exactly when configured is true", () => {
      const configured = makeService({
        RAZORPAY_KEY_ID: "rzp_test_FAKE",
        RAZORPAY_KEY_SECRET: "fake_secret",
      });
      const unconfigured = makeService({});

      const configuredReadiness = configured.readiness();
      const unconfiguredReadiness = unconfigured.readiness();

      expect(configuredReadiness.configured).toBe(true);
      expect(configuredReadiness.unavailableReason).toBeNull();
      expect(unconfiguredReadiness.configured).toBe(false);
      expect(unconfiguredReadiness.unavailableReason).not.toBeNull();
    });
  });
});
