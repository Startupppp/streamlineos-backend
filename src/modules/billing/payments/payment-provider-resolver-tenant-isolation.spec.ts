// Service under test: src/modules/billing/payments/payment-provider-resolver.service.ts
import type { Db } from "../../../db/drizzle.module";
import { stubService } from "../../../test/service-stub.spec-fixtures";
import type { PaymentProviderAdapter, PaymentProviderAdapterRegistry, PaymentProviderRuntime } from "./payment-provider-adapter.interface";
import type { PaymentProviderSetupService } from "./payment-provider-setup.service";
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
    const mockRegistry = stubService<PaymentProviderAdapterRegistry>({ get: jest.fn().mockReturnValue(undefined) });
    const mockSetup = stubService<PaymentProviderSetupService>({ getDecryptedSecret: jest.fn() });
    const svc = new PaymentProviderResolver(db, mockRegistry, mockSetup);
    const result = await svc.resolve(ATTACKER, "razorpay");
    expect(result).toBeUndefined();
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
    const mockAdapter = stubService<PaymentProviderAdapter>({ configure: jest.fn().mockReturnValue(mockRuntime) });
    const mockRegistry = stubService<PaymentProviderAdapterRegistry>({ get: jest.fn().mockReturnValue(mockAdapter) });
    const mockSetup = stubService<PaymentProviderSetupService>({ getDecryptedSecret: jest.fn().mockResolvedValue({ keyId: "k", secret: "s" }) });
    const svc = new PaymentProviderResolver(db, mockRegistry, mockSetup);
    const result = await svc.resolve(OWNER, "razorpay");
    expect(result).toBeDefined();
  });
});
