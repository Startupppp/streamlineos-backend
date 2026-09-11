// Service under test: src/modules/billing/payments/payment-provider-resolver.service.ts
/*
  The resolver opens the organisation's own transaction (`runInNewTenantTransaction`),
  which routes through the regional pool. The double below is a bare query surface,
  so the helper is replaced with one that hands that surface to the callback as the
  transaction — and records the org it was opened for, which is the tenant boundary
  this spec exists to pin.
*/
jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: jest.fn(<T>(db: unknown, fn: (tx: unknown) => Promise<T>) => fn(db)),
  runInNewTenantTransaction: jest.fn(<T>(db: unknown, _orgId: string, fn: (tx: unknown) => Promise<T>) => fn(db)),
}));

import type { Db } from "../../../db/drizzle.module";
import { runInNewTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { PaymentProviderResolver } from "./payment-provider-resolver.service";

describe("PaymentProviderResolver — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  function makeDb(providerRow: unknown): Db {
    const findFirst = jest.fn().mockResolvedValue(providerRow);
    return { query: { paymentProviders: { findFirst } } } as unknown as Db;
  }

  it("returns undefined for a different org (cross-tenant isolation — no provider disclosed)", async () => {
    const db = makeDb(null);
    const mockRegistry = { get: jest.fn().mockReturnValue(undefined) } as any;
    const mockSetup = { getDecryptedSecret: jest.fn() } as any;
    const svc = new PaymentProviderResolver(db, mockRegistry, mockSetup);
    const result = await svc.resolve(ATTACKER, "razorpay");
    expect(result).toBeUndefined();
    expect(runInNewTenantTransaction).toHaveBeenCalledWith(db, ATTACKER, expect.any(Function));
  });

  it("returns provider for the owning org (control — same-tenant)", async () => {
    const providerRow = { id: 1, orgId: OWNER, providerKey: "razorpay", status: "active", environment: "test" };
    const db = makeDb(providerRow);
    const mockRuntime = {
      isReady: jest.fn().mockReturnValue(true),
      publicKeyId: jest.fn().mockReturnValue("k"),
      createOrder: jest.fn(),
      verifyPaymentSignature: jest.fn(),
      verifyWebhookSignature: jest.fn(),
      normalizeWebhook: jest.fn(),
    };
    const mockAdapter = { configure: jest.fn().mockReturnValue(mockRuntime) } as any;
    const mockRegistry = { get: jest.fn().mockReturnValue(mockAdapter) } as any;
    const mockSetup = { getDecryptedSecret: jest.fn().mockResolvedValue({ keyId: "k", secret: "s" }) } as any;
    const svc = new PaymentProviderResolver(db, mockRegistry, mockSetup);
    const result = await svc.resolve(OWNER, "razorpay");
    expect(result).toBeDefined();
    expect(runInNewTenantTransaction).toHaveBeenCalledWith(db, OWNER, expect.any(Function));
  });
});
