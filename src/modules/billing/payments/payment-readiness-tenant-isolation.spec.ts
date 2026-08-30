import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { PaymentReadinessService } from "./payment-readiness.service";

describe("PaymentReadinessService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  function makeDb(providerRow: unknown): Db {
    const findFirst = jest.fn().mockResolvedValue(providerRow);
    return {
      query: {
        paymentProviders: { findFirst },
        paymentProviderCredentials: { findFirst: jest.fn().mockResolvedValue(null) },
        paymentWebhookEndpoints: { findFirst: jest.fn().mockResolvedValue(null) },
        paymentTestTransactions: { findFirst: jest.fn().mockResolvedValue(null) },
        paymentProviderAccounts: { findFirst: jest.fn().mockResolvedValue(null) },
      },
    } as unknown as Db;
  }

  it("throws NotFoundException when provider belongs to a different org (cross-tenant isolation)", async () => {
    const db = makeDb(null);
    const mockRegistry = { getAdapter: jest.fn() } as any;
    const mockAudit = { log: jest.fn() } as any;
    const mockAnalytics = {} as any;
    const svc = new PaymentReadinessService(db, mockRegistry, mockAudit, mockAnalytics);
    await expect(svc.getReadiness(ATTACKER, "razorpay")).rejects.toThrow(NotFoundException);
  });

  it("returns readiness for the owning org (control — same-tenant)", async () => {
    const providerRow = { id: 1, orgId: OWNER, providerKey: "razorpay", environment: "test" };
    const db = makeDb(providerRow);
    const mockRegistry = { getAdapter: jest.fn() } as any;
    const mockAudit = { log: jest.fn() } as any;
    const mockAnalytics = {} as any;
    const svc = new PaymentReadinessService(db, mockRegistry, mockAudit, mockAnalytics);
    const result = await svc.getReadiness(OWNER, "razorpay");
    expect(result).toHaveProperty("readyForLive");
  });
});
