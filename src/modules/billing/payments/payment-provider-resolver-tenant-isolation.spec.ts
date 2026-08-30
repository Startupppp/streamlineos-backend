// Service under test: src/modules/billing/payments/payment-provider-resolver.service.ts
import type { Db } from "../../../db/drizzle.module";
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
  });

  it("returns provider for the owning org (control — same-tenant)", async () => {
    const providerRow = { id: 1, orgId: OWNER, providerKey: "razorpay", status: "active", environment: "test" };
    const db = makeDb(providerRow);
    const mockAdapter = { buildProvider: jest.fn() } as any;
    const mockRegistry = { get: jest.fn().mockReturnValue(mockAdapter) } as any;
    const mockSetup = { getDecryptedSecret: jest.fn().mockResolvedValue({ keyId: "k", secret: "s" }) } as any;
    const svc = new PaymentProviderResolver(db, mockRegistry, mockSetup);
    const result = await svc.resolve(OWNER, "razorpay");
    expect(result).toBeDefined();
  });
});
