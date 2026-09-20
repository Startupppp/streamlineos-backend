/**
 * The purchase row must be written BEFORE the payment provider is called.
 *
 * The reverse order — which `createOrder` used to do — creates a payable order at the provider
 * that no local row points at whenever the insert fails. The payment is still recorded when it
 * arrives (the webhook resolves the org from `notes`), but activation is gated on a purchase row
 * existing, so the customer is charged and granted nothing. A missing GRANT made that fire on every
 * attempt; fixing the grant made it stop reproducing without removing it, which is why the ordering
 * is pinned here rather than left to the condition that exposed it.
 */
import { BillingPaymentActivation } from "./billing-payment-activation";

jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInNewTenantTransaction: jest.fn(
    async (
      db: { transaction: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown> },
      _orgId: string,
      fn: (tx: unknown) => Promise<unknown>,
    ) => db.transaction(fn),
  ),
}));

const ORG = "org-intent";
const USER = "user-intent";
const MERCHANT_KEY_ID = "rzp_test_intent";

function build(options: { orderFails?: boolean; claimReturnsNull?: boolean } = {}) {
  const calls: string[] = [];

  const create = jest.fn().mockImplementation((_tx: unknown, input: Record<string, unknown>) => {
    calls.push("purchase.create");
    return Promise.resolve({ id: 7, orgId: ORG, providerOrderId: input.providerOrderId ?? null });
  });
  const attachProviderOrder = jest.fn().mockImplementation(() => {
    calls.push("purchase.attachProviderOrder");
    return Promise.resolve(options.claimReturnsNull === true ? null : { id: 7, orgId: ORG, expiresAt: new Date(Date.now() + 30 * 60 * 1000) });
  });
  const markFailed = jest.fn().mockImplementation(() => {
    calls.push("purchase.markFailed");
    return Promise.resolve(undefined);
  });

  const createOrder = jest.fn().mockImplementation(() => {
    calls.push("provider.createOrder");
    if (options.orderFails === true) return Promise.reject(new Error("provider unreachable"));
    return Promise.resolve({ providerOrderId: "order_intent_1" });
  });

  const provider = {
    providerKey: "razorpay",
    environment: "test",
    isReady: () => true,
    publicKeyId: () => MERCHANT_KEY_ID,
    createOrder,
    verifyPaymentSignature: () => true,
    verifyWebhookSignature: () => true,
    normalizeWebhook: jest.fn(),
    fetchPayment: jest.fn(),
  };

  const activation = new BillingPaymentActivation(
    {
      transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb({})),
    } as never,
    undefined as never,
    { log: jest.fn() } as never,
    {} as never,
    {} as never,
    {} as never,
    { getActivePriceForPlanTier: jest.fn().mockResolvedValue(null) } as never,
    {} as never,
    {} as never,
    {} as never,
    {
      resolve: () => provider,
      readiness: () => ({
        configured: true,
        providerKey: "razorpay",
        environment: "test",
        publicKeyId: MERCHANT_KEY_ID,
        webhookConfigured: true,
        unavailableReason: null,
      }),
      environment: () => "test",
    } as never,
    {} as never,
  );
  const purchaseSvc = { create, attachProviderOrder, markFailed };
  Reflect.set(activation, 'purchaseService', purchaseSvc);
  Reflect.set(Reflect.get(activation, 'orderCreation') as object, 'purchaseService', purchaseSvc);

  return { activation, calls, create, attachProviderOrder, markFailed, createOrder };
}

describe("createOrder — the local intent row precedes the provider call", () => {
  it("writes the purchase BEFORE asking the provider for an order", async () => {
    const h = build();

    await h.activation.createOrder(ORG, USER, "PROFESSIONAL", "monthly");

    expect(h.calls.indexOf("purchase.create")).toBeGreaterThanOrEqual(0);
    expect(h.calls.indexOf("provider.createOrder")).toBeGreaterThan(h.calls.indexOf("purchase.create"));
  });

  it("creates that row with no provider order id, because none exists yet", async () => {
    const h = build();

    await h.activation.createOrder(ORG, USER, "PROFESSIONAL", "monthly");

    const input = h.create.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(input.providerOrderId).toBeNull();
  });

  it("claims the row with the order id once the provider has issued one", async () => {
    const h = build();

    const result = await h.activation.createOrder(ORG, USER, "PROFESSIONAL", "monthly");

    expect(h.attachProviderOrder).toHaveBeenCalledWith({}, 7, ORG, "order_intent_1");
    expect(result.orderId).toBe("order_intent_1");
    expect(result.purchaseId).toBe(7);
  });

  it("carries the purchase id to the provider, so an orphan is traceable from their side", async () => {
    const h = build();

    await h.activation.createOrder(ORG, USER, "PROFESSIONAL", "monthly");

    const sent = h.createOrder.mock.calls[0]?.[0] as { receipt: string; notes: Record<string, string> };
    expect(sent.notes.purchaseId).toBe("7");
    expect(sent.receipt).toContain("7");
  });

  it("retires the intent when the provider call fails, leaving no payable order and no live row", async () => {
    const h = build({ orderFails: true });

    await expect(
      h.activation.createOrder(ORG, USER, "PROFESSIONAL", "monthly"),
    ).rejects.toThrow("provider unreachable");

    expect(h.markFailed).toHaveBeenCalled();
    expect(h.calls).toEqual(["purchase.create", "provider.createOrder", "purchase.markFailed"]);
  });

  it("refuses to report success when the row could not be claimed", async () => {
    const h = build({ claimReturnsNull: true });

    await expect(
      h.activation.createOrder(ORG, USER, "PROFESSIONAL", "monthly"),
    ).rejects.toThrow(/could not be claimed/);
  });
});
