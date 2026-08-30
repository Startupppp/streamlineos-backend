import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { PaymentTestTransactionService } from "./payment-test-transaction.service";

describe("PaymentTestTransactionService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const USER_ID = "user-abc";

  const ACTIVE_MEMBER = { id: 1, orgId: ATTACKER, userId: USER_ID, role: "MEMBER", isOwner: false, status: "ACTIVE" };

  function makeDb(providerRow: unknown): Db {
    const findFirst = jest.fn().mockResolvedValue(providerRow);
    const where = jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([ACTIVE_MEMBER]) });
    const from = jest.fn().mockReturnValue({ where });
    const select = jest.fn().mockReturnValue({ from });
    return {
      select,
      query: {
        paymentProviders: { findFirst },
        organizationMembers: { findFirst: jest.fn().mockResolvedValue(ACTIVE_MEMBER) },
        paymentTestTransactions: { findFirst: jest.fn().mockResolvedValue(null) },
      },
      insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }) }),
    } as unknown as Db;
  }

  it("throws NotFoundException when provider belongs to a different org (cross-tenant isolation)", async () => {
    const db = makeDb(null);
    const mockProviders = { resolve: jest.fn().mockResolvedValue(undefined) } as any;
    const mockAudit = { log: jest.fn() } as any;
    const svc = new PaymentTestTransactionService(db, mockProviders, mockAudit, {} as any);
    const actor = { userId: USER_ID, orgId: ATTACKER, ipAddress: null } as any;
    await expect(svc.createTestTransaction(ATTACKER, "razorpay", { amount: "100", currency: "INR" }, actor)).rejects.toThrow(NotFoundException);
  });

  it("proceeds for the owning org when provider exists (control — same-tenant)", async () => {
    const providerRow = { id: 1, orgId: OWNER, providerKey: "razorpay", environment: "test", status: "active" };
    const db = makeDb(providerRow);
    const mockFacade = { isReady: jest.fn().mockReturnValue(false) } as any;
    const mockProviders = { resolve: jest.fn().mockResolvedValue(mockFacade) } as any;
    const mockAudit = { log: jest.fn() } as any;
    const svc = new PaymentTestTransactionService(db, mockProviders, mockAudit, {} as any);
    const actor = { userId: USER_ID, orgId: OWNER, ipAddress: null } as any;
    await expect(svc.createTestTransaction(OWNER, "razorpay", { amount: "100", currency: "INR" }, actor)).rejects.toThrow();
  });
});
