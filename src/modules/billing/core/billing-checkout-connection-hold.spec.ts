/**
 * Both checkout routes call a payment provider over HTTP, with a 10s budget.
 *
 * `TenantContextInterceptor` wraps every authenticated request in a Postgres
 * transaction held for the request's whole lifetime, and the pool is 10 on RDS.
 * Without an opt-out, one checkout occupies a tenth of an instance's entire
 * concurrency for as long as the provider takes to answer — and Postgres cannot
 * end it, because `statement_timeout` does not fire while no statement is
 * running.
 *
 * Removing either decorator reintroduces that hold silently: nothing fails, the
 * endpoint just starts costing a connection per in-flight second. These read the
 * metadata the interceptor actually consults.
 */
import { NO_TENANT_TRANSACTION } from "../../../common/tenant/no-tenant-transaction.decorator";
import { BillingController } from "./billing.controller";

function optedOut(handler: keyof BillingController): boolean {
  return (
    Reflect.getMetadata(NO_TENANT_TRANSACTION, BillingController.prototype[handler]) === true
  );
}

describe("billing routes that call a payment provider do not hold a pooled connection", () => {
  it("POST /billing/checkout is opted out, because it waits on Stripe or Razorpay for up to 10s", () => {
    expect(optedOut("checkout")).toBe(true);
  });

  it("POST /billing/addons/purchase is opted out, for the same provider round trip", () => {
    expect(optedOut("purchaseAddon")).toBe(true);
  });

  it("ANTI-VACUITY: a route with no provider call is NOT opted out, so the check reads real metadata", () => {
    expect(optedOut("getMarketplace")).toBe(false);
  });
});
