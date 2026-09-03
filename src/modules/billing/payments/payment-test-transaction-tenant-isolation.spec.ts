import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { PaymentTestTransactionService } from "./payment-test-transaction.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const r = value as Record<string, unknown>;
  return [
    ...(Array.isArray(r["queryChunks"]) ? sqlValues(r["queryChunks"], seen) : []),
    ...("value" in r ? sqlValues(r["value"], seen) : []),
  ];
}

describe("PaymentTestTransactionService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const USER_ID = "user-abc";

  const ACTIVE_MEMBER = { id: 1, orgId: ATTACKER, userId: USER_ID, role: "MEMBER", isOwner: false, status: "ACTIVE" };

  function makeDb(providerRow: unknown) {
    const findFirst = jest.fn().mockResolvedValue(providerRow);
    const where = jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([ACTIVE_MEMBER]) });
    const from = jest.fn().mockReturnValue({ where });
    const select = jest.fn().mockReturnValue({ from });
    const insertValues = jest.fn().mockReturnValue({
      returning: jest.fn().mockResolvedValue([{ id: 77, orgId: OWNER, status: "created" }]),
    });
    const updateWhere = jest.fn().mockReturnValue({
      returning: jest.fn().mockResolvedValue([{ id: 77, orgId: OWNER, status: "pending", providerOrderId: "order_1" }]),
    });
    const db = {
      select,
      query: {
        paymentProviders: { findFirst },
        organizationMembers: { findFirst: jest.fn().mockResolvedValue(ACTIVE_MEMBER) },
        paymentTestTransactions: { findFirst: jest.fn().mockResolvedValue(null) },
      },
      insert: jest.fn().mockReturnValue({ values: insertValues }),
      update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: updateWhere }) }),
    } as unknown as Db;
    return { db, findFirst, insertValues, updateWhere };
  }

  it("throws NotFoundException when provider belongs to a different org (cross-tenant isolation)", async () => {
    const { db, findFirst, insertValues } = makeDb(null);
    const mockProviders = { resolve: jest.fn().mockResolvedValue(undefined) } as any;
    const mockAudit = { log: jest.fn() } as any;
    const svc = new PaymentTestTransactionService(db, mockProviders, mockAudit, {} as any);
    const actor = { userId: USER_ID, orgId: ATTACKER, ipAddress: null } as any;
    await expect(svc.createTestTransaction(ATTACKER, "razorpay", { amount: "100", currency: "INR" }, actor)).rejects.toThrow(NotFoundException);
    expect(sqlValues((findFirst.mock.calls[0]?.[0] as Record<string, unknown> | undefined)?.["where"])).toContain(ATTACKER);
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("proceeds for the owning org when provider exists (control — same-tenant)", async () => {
    const providerRow = { id: 1, orgId: OWNER, providerKey: "razorpay", environment: "test", status: "active" };
    const { db, findFirst, insertValues, updateWhere } = makeDb(providerRow);
    const mockFacade = {
      isReady: jest.fn().mockReturnValue(true),
      createOrder: jest.fn().mockResolvedValue({ providerOrderId: "order_1" }),
      publicKeyId: jest.fn().mockReturnValue("key_test"),
    } as any;
    const mockProviders = { resolve: jest.fn().mockResolvedValue(mockFacade) } as any;
    const mockAudit = { log: jest.fn().mockResolvedValue(undefined) } as any;
    const mockAnalytics = { track: jest.fn() } as any;
    const svc = new PaymentTestTransactionService(db, mockProviders, mockAudit, mockAnalytics);
    const actor = { userId: USER_ID, orgId: OWNER, ipAddress: null } as any;

    const result = await svc.createTestTransaction(OWNER, "razorpay", { amount: "100", currency: "INR" }, actor);

    expect(result).toMatchObject({ id: 77, status: "pending", providerOrderId: "order_1", keyId: "key_test" });
    expect(sqlValues((findFirst.mock.calls[0]?.[0] as Record<string, unknown> | undefined)?.["where"])).toContain(OWNER);
    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({ orgId: OWNER, environment: "test" }));
    expect(sqlValues(updateWhere.mock.calls[0]?.[0])).toContain(OWNER);
    expect(mockAudit.log).toHaveBeenCalledWith(expect.objectContaining({ orgId: OWNER }));
  });
});
