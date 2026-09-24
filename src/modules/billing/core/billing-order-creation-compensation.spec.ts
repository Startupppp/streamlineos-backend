/**
 * `createOrder` writes a purchase intent, calls the payment provider, then
 * attaches the returned order id. The provider call sits deliberately between
 * two short transactions, and both failure paths compensate: `abandonIntent`
 * marks the intent FAILED, `releaseReservation` returns the coupon.
 *
 * Today that compensation is nearly decorative. `TenantContextInterceptor`
 * holds one transaction for the whole request and `runInTenantTransaction`
 * joins it, so the inner `db.transaction` calls are savepoints — when
 * `createOrder` rethrows, the request transaction rolls the intent row back
 * regardless of whether the compensation did anything.
 *
 * Releasing the pooled connection across the provider call means the intent row
 * genuinely commits first, and these paths become the only thing that retires a
 * purchase whose provider call failed. So they are pinned here BEFORE the split,
 * against the behaviour as it stands, and must keep passing after it.
 */
import { BillingOrderCreation } from "./billing-order-creation";
import { BillingCoupons } from "./billing-coupons";
import { runInNewTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";

jest.mock("./billing-coupons");
jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInNewTenantTransaction: jest.fn(
    async (
      db: { transaction: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown> },
      _orgId: string,
      fn: (tx: unknown) => Promise<unknown>,
    ) => db.transaction(fn),
  ),
}));

const openedTransaction = runInNewTenantTransaction as jest.MockedFunction<
  typeof runInNewTenantTransaction
>;

const MockedCoupons = BillingCoupons as jest.MockedClass<typeof BillingCoupons>;

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const PROVIDER_FAILURE = new Error("gateway refused the order");

function makeDeps(overrides: {
  createOrder: jest.Mock;
  markFailed?: jest.Mock;
  release?: jest.Mock;
  reserve?: jest.Mock;
}) {
  const markFailed = overrides.markFailed ?? jest.fn().mockResolvedValue(undefined);
  const attachProviderOrder = jest.fn().mockResolvedValue({ expiresAt: new Date() });
  const create = jest.fn().mockResolvedValue({ id: 4242 });

  MockedCoupons.mockImplementation(
    () =>
      ({
        reserve:
          overrides.reserve ??
          jest.fn().mockResolvedValue({ reserved: true, discountAmountMinor: 10_000 }),
        release: overrides.release ?? jest.fn().mockResolvedValue(undefined),
      }) as unknown as BillingCoupons,
  );

  const db = {
    transaction: jest.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback({})),
  };

  const deps = {
    db: db as never,
    catalog: { getActivePriceForPlanTier: jest.fn().mockResolvedValue(null) } as never,
    platformMerchant: {
      resolve: jest.fn().mockReturnValue({
        providerKey: "razorpay",
        isReady: () => true,
        createOrder: overrides.createOrder,
      }),
      readiness: jest.fn().mockReturnValue({ configured: true, publicKeyId: "key_test" }),
      environment: jest.fn().mockReturnValue("test"),
    } as never,
    purchaseService: { create, markFailed, attachProviderOrder } as never,
  };

  return { deps, markFailed, create, attachProviderOrder, db };
}

describe("billing order creation — compensation when the payment provider fails", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it("retires the purchase intent, so a committed intent cannot outlive the provider call that failed", async () => {
    const createOrder = jest.fn().mockRejectedValue(PROVIDER_FAILURE);
    const { deps, markFailed } = makeDeps({ createOrder });

    await expect(
      new BillingOrderCreation(deps).createOrder(ORG_ID, USER_ID, "STARTER", "monthly"),
    ).rejects.toThrow("gateway refused the order");

    expect(markFailed).toHaveBeenCalledTimes(1);
    const [, purchaseId, orgId] = markFailed.mock.calls[0] ?? [];
    expect(purchaseId).toBe(4242);
    expect(orgId).toBe(ORG_ID);
  });

  it("returns the reserved coupon, so a failed checkout does not consume the customer's discount", async () => {
    const createOrder = jest.fn().mockRejectedValue(PROVIDER_FAILURE);
    const release = jest.fn().mockResolvedValue(undefined);
    const { deps } = makeDeps({ createOrder, release });

    await expect(
      new BillingOrderCreation(deps).createOrder(ORG_ID, USER_ID, "STARTER", "monthly", 77),
    ).rejects.toThrow("gateway refused the order");

    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(expect.anything(), 77);
  });

  it("surfaces the provider's error and not the compensation's, so the cause is never masked by the cleanup", async () => {
    const createOrder = jest.fn().mockRejectedValue(PROVIDER_FAILURE);
    const markFailed = jest.fn().mockRejectedValue(new Error("markFailed also died"));
    const release = jest.fn().mockRejectedValue(new Error("release also died"));
    const { deps } = makeDeps({ createOrder, markFailed, release });

    await expect(
      new BillingOrderCreation(deps).createOrder(ORG_ID, USER_ID, "STARTER", "monthly", 77),
    ).rejects.toThrow("gateway refused the order");
  });

  it("does not release a coupon that was never reserved", async () => {
    const createOrder = jest.fn().mockRejectedValue(PROVIDER_FAILURE);
    const release = jest.fn().mockResolvedValue(undefined);
    const { deps } = makeDeps({ createOrder, release });

    await expect(
      new BillingOrderCreation(deps).createOrder(ORG_ID, USER_ID, "STARTER", "monthly"),
    ).rejects.toThrow("gateway refused the order");

    expect(release).not.toHaveBeenCalled();
  });

  it("ANTI-VACUITY: a succeeding provider call compensates nothing and attaches the order", async () => {
    const createOrder = jest.fn().mockResolvedValue({ providerOrderId: "order_live_1" });
    const release = jest.fn().mockResolvedValue(undefined);
    const { deps, markFailed, attachProviderOrder } = makeDeps({ createOrder, release });

    const result = await new BillingOrderCreation(deps).createOrder(
      ORG_ID,
      USER_ID,
      "STARTER",
      "monthly",
      77,
    );

    expect(result.orderId).toBe("order_live_1");
    expect(markFailed).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(attachProviderOrder).toHaveBeenCalledTimes(1);
  });

  it("the transaction mock really invokes its callback, or every assertion above would be vacuous", async () => {
    const createOrder = jest.fn().mockResolvedValue({ providerOrderId: "order_live_2" });
    const { deps, create } = makeDeps({ createOrder });

    await new BillingOrderCreation(deps).createOrder(ORG_ID, USER_ID, "STARTER", "monthly");

    expect(openedTransaction).toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("opens its own tenant transactions rather than joining the request's, so no connection is held across the provider call", async () => {
    const createOrder = jest.fn().mockResolvedValue({ providerOrderId: "order_live_3" });
    const { deps } = makeDeps({ createOrder });

    await new BillingOrderCreation(deps).createOrder(ORG_ID, USER_ID, "STARTER", "monthly");

    expect(openedTransaction.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const call of openedTransaction.mock.calls) expect(call[1]).toBe(ORG_ID);
  });
});
