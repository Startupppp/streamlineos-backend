import { PaymentProviderResolver } from "./payment-provider-resolver.service";
import { PaymentProviderAdapterRegistry } from "./payment-provider-adapter.interface";
import { FakeProviderAdapter } from "./testing/fake-provider-adapter";

describe("PaymentProviderResolver", () => {
  it("resolves the adapter and credentials per organization without exposing secrets to callers", async () => {
    const adapter = new FakeProviderAdapter();
    const registry = new PaymentProviderAdapterRegistry();
    registry.register(adapter);
    const db: Record<string, unknown> = {
    /*
      `transaction` and `execute`, because the reads open the organisation's own
      transaction now — the tables they touch are under row-level security, and a
      bare read matches nothing. The double runs the body against itself, so what
      each case observes is unchanged.
    */
      transaction: (body: (handle: unknown) => Promise<unknown>) => body(db),
      execute: () => Promise.resolve([]),
      query: {
        paymentProviders: {
          findFirst: jest.fn().mockImplementation(async ({ where }: { where: unknown }) =>
            where ? { id: 7, orgId: "org-a", providerKey: "razorpay", environment: "test", status: "test_mode_ready" } : undefined,
          ),
        },
      },
    };
    const setup = {
      getDecryptedSecret: jest.fn().mockResolvedValue({
        keyId: "rzp_test_org_a",
        secret: "private-org-a",
        webhookSecret: "webhook-org-a",
      }),
    };
    const resolver = new PaymentProviderResolver(db as never, registry, setup as never);

    const provider = await resolver.resolve("org-a", "razorpay");

    expect(provider?.publicKeyId()).toBe("rzp_test_org_a");
    expect(provider?.isReady()).toBe(true);
    expect(provider && "keySecret" in provider).toBe(false);
    expect(provider && "webhookSecret" in provider).toBe(false);
    await provider?.createOrder({ amount: "100", currency: "INR", receipt: "receipt" });
    expect(provider?.normalizeWebhook(JSON.stringify({ event: "payment.captured", payload: {} }))).toEqual({
      ok: true,
      eventType: "payment.captured",
      payload: {},
    });
    expect(provider?.verifyWebhookSignature({ rawBody: "body", signature: "signature" })).toBe(false);
    expect(setup.getDecryptedSecret).toHaveBeenCalledWith("org-a", 7, "test");
  });

  it("does not resolve a provider belonging to another organization", async () => {
    const registry = new PaymentProviderAdapterRegistry();
    registry.register(new FakeProviderAdapter());
    const db: Record<string, unknown> = {
    /*
      `transaction` and `execute`, because the reads open the organisation's own
      transaction now — the tables they touch are under row-level security, and a
      bare read matches nothing. The double runs the body against itself, so what
      each case observes is unchanged.
    */
      transaction: (body: (handle: unknown) => Promise<unknown>) => body(db),
      execute: () => Promise.resolve([]),
      query: {
        paymentProviders: { findFirst: jest.fn().mockResolvedValue(undefined) },
      },
    };
    const setup = { getDecryptedSecret: jest.fn() };
    const resolver = new PaymentProviderResolver(db as never, registry, setup as never);

    expect(await resolver.resolve("org-b", "razorpay")).toBeUndefined();
    expect(setup.getDecryptedSecret).not.toHaveBeenCalled();
  });

  it("resolves the organisation primary provider without a hard-coded provider key", async () => {
    const adapter = new FakeProviderAdapter("stripe");
    const registry = new PaymentProviderAdapterRegistry();
    registry.register(adapter);
    const findMany = jest.fn().mockResolvedValue([
      { id: 8, orgId: "org-a", providerKey: "stripe", environment: "test", status: "test_mode_ready", isPrimary: true },
    ]);
    const findFirst = jest.fn().mockResolvedValue({
      id: 8,
      orgId: "org-a",
      providerKey: "stripe",
      environment: "test",
      status: "test_mode_ready",
    });
    // Same as the doubles above: the reads run in the organisation's own
    // transaction, so the double has to be able to open one.
    const db: Record<string, unknown> = {
      transaction: (body: (handle: unknown) => Promise<unknown>) => body(db),
      execute: () => Promise.resolve([]),
      query: { paymentProviders: { findMany, findFirst } },
    };
    const setup = {
      getDecryptedSecret: jest.fn().mockResolvedValue({
        keyId: "stripe_public",
        secret: "stripe_private",
        webhookSecret: "stripe_webhook",
      }),
    };
    const resolver = new PaymentProviderResolver(db as never, registry, setup as never);

    const provider = await resolver.resolveConfigured("org-a");

    expect(provider?.providerKey).toBe("stripe");
    expect(findMany).toHaveBeenCalled();
    expect(setup.getDecryptedSecret).toHaveBeenCalledWith("org-a", 8, "test");
  });
});
