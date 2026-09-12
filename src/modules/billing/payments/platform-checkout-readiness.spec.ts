import { PaymentProviderAdapterRegistry } from "./payment-provider-adapter.interface";
import { FakeProviderAdapter } from "./testing/fake-provider-adapter";
import { PlatformMerchantService } from "./platform-merchant.service";

function makeService(
  config: { RAZORPAY_KEY_ID?: string; RAZORPAY_KEY_SECRET?: string; RAZORPAY_WEBHOOK_SECRET?: string } | undefined,
  registry?: PaymentProviderAdapterRegistry,
): PlatformMerchantService {
  const reg = registry ?? (() => {
    const r = new PaymentProviderAdapterRegistry();
    r.register(new FakeProviderAdapter("razorpay"));
    return r;
  })();
  return new PlatformMerchantService(reg, config as never);
}

describe("Platform checkout readiness — AB-01 diagnosis", () => {
  it("case 1: tenant payment_providers rows absent AND platform env absent → configured:false, unavailableReason:no_credentials", () => {
    const svc = makeService({});
    const r = svc.readiness();
    expect(r.configured).toBe(false);
    expect(r.unavailableReason).toBe("no_credentials");
  });

  it("case 2: tenant rows absent BUT platform env present → configured:true (AB-F01 regression proof — fresh tenant can now check out via platform credentials)", () => {
    const svc = makeService({
      RAZORPAY_KEY_ID: "rzp_test_FAKE",
      RAZORPAY_KEY_SECRET: "fake_secret",
    });
    const r = svc.readiness();
    expect(r.configured).toBe(true);
    expect(r.publicKeyId).toBe("rzp_test_FAKE");
    expect(r.environment).toBe("test");
    expect(r.unavailableReason).toBeNull();
  });

  it("case 3: keyId present, secret absent → incomplete_credentials, configured:false", () => {
    const svc = makeService({ RAZORPAY_KEY_ID: "rzp_test_FAKE" });
    const r = svc.readiness();
    expect(r.configured).toBe(false);
    expect(r.unavailableReason).toBe("incomplete_credentials");
  });

  it("case 4: registry without a razorpay adapter → unsupported_provider", () => {
    const emptyRegistry = new PaymentProviderAdapterRegistry();
    const svc = makeService(
      { RAZORPAY_KEY_ID: "rzp_test_FAKE", RAZORPAY_KEY_SECRET: "fake_secret" },
      emptyRegistry,
    );
    const r = svc.readiness();
    expect(r.configured).toBe(false);
    expect(r.unavailableReason).toBe("unsupported_provider");
  });

  it("case 5: readiness() output contains no secret material", () => {
    const svc = makeService({
      RAZORPAY_KEY_ID: "rzp_test_FAKE",
      RAZORPAY_KEY_SECRET: "SENTINEL_SECRET_VALUE",
      RAZORPAY_WEBHOOK_SECRET: "SENTINEL_WEBHOOK_VALUE",
    });
    const serialized = JSON.stringify(svc.readiness());
    expect(serialized).not.toContain("SENTINEL_SECRET_VALUE");
    expect(serialized).not.toContain("SENTINEL_WEBHOOK_VALUE");
  });

  it("case 6: a live-prefixed key reports environment:live", () => {
    const svc = makeService({
      RAZORPAY_KEY_ID: "rzp_live_FAKE",
      RAZORPAY_KEY_SECRET: "fake_secret",
    });
    expect(svc.readiness().environment).toBe("live");
  });

  it("case 7: unrecognised key prefix → environment() null, configured:false, incomplete_credentials (never silently activates live mode)", () => {
    const svc = makeService({
      RAZORPAY_KEY_ID: "rzp_test_FAKE",
      RAZORPAY_KEY_SECRET: "fake_secret",
    });
    const badPrefixSvc = makeService({
      RAZORPAY_KEY_ID: "badprefix_key",
      RAZORPAY_KEY_SECRET: "fake_secret",
    });
    expect(svc.environment()).toBe("test");
    expect(badPrefixSvc.environment()).toBeNull();
    const r = badPrefixSvc.readiness();
    expect(r.configured).toBe(false);
    expect(r.unavailableReason).toBe("incomplete_credentials");
  });

  it("PlatformMerchantService never touches the database — constructing without a Db injection does not throw", () => {
    const registry = new PaymentProviderAdapterRegistry();
    registry.register(new FakeProviderAdapter("razorpay"));
    const svc = new PlatformMerchantService(registry, {
      RAZORPAY_KEY_ID: "rzp_test_FAKE",
      RAZORPAY_KEY_SECRET: "fake_secret",
      RAZORPAY_WEBHOOK_SECRET: "fake_webhook_secret",
    } as never);
    expect(() => svc.resolve()).not.toThrow();
    expect(() => svc.readiness()).not.toThrow();
    expect(() => svc.environment()).not.toThrow();
  });
});
