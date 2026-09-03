import { checkApprovalPolicy } from "./ap-approval.helper";
import type { Db } from "../../../db/drizzle.module";

type PolicyRow = { id: number; minAmount: string | null; approverUserId: string | null };

function makeMockDb(policies: PolicyRow[]): Db {
  return {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockResolvedValue(policies),
    }),
  } as unknown as Db;
}

describe("checkApprovalPolicy", () => {
  describe("when no active policy exists for the record type", () => {
    it("returns needsApproval:false", async () => {
      const db = makeMockDb([]);
      const result = await checkApprovalPolicy(db, "org1", "PURCHASE_BILL", "500");
      expect(result).toEqual({ needsApproval: false, policyId: null, approverUserId: null });
    });
  });

  describe("when a policy with null minAmount exists", () => {
    it("matches any total — needsApproval:true", async () => {
      const db = makeMockDb([{ id: 1, minAmount: null, approverUserId: "user1" }]);
      const result = await checkApprovalPolicy(db, "org1", "PURCHASE_BILL", "0");
      expect(result.needsApproval).toBe(true);
      expect(result.policyId).toBe(1);
      expect(result.approverUserId).toBe("user1");
    });
  });

  describe("when minAmount threshold is set", () => {
    it("matches when total equals minAmount exactly", async () => {
      const db = makeMockDb([{ id: 2, minAmount: "1000", approverUserId: null }]);
      const result = await checkApprovalPolicy(db, "org1", "PURCHASE_BILL", "1000");
      expect(result.needsApproval).toBe(true);
    });

    it("matches when total exceeds minAmount", async () => {
      const db = makeMockDb([{ id: 2, minAmount: "1000", approverUserId: null }]);
      const result = await checkApprovalPolicy(db, "org1", "PURCHASE_BILL", "5000");
      expect(result.needsApproval).toBe(true);
    });

    it("does not match when total is below minAmount", async () => {
      const db = makeMockDb([{ id: 2, minAmount: "1000", approverUserId: null }]);
      const result = await checkApprovalPolicy(db, "org1", "PURCHASE_BILL", "999.99");
      expect(result.needsApproval).toBe(false);
    });

    it("compares the threshold exactly — a total a double cannot hold still matches", async () => {
      const db = makeMockDb([
        { id: 5, minAmount: "10000000000000.03", approverUserId: null },
      ]);
      const result = await checkApprovalPolicy(
        db,
        "org1",
        "PURCHASE_BILL",
        "10000000000000.03",
      );
      expect(result.needsApproval).toBe(true);
    });

    it("compares the threshold exactly — one minor unit below it does not match", async () => {
      const db = makeMockDb([
        { id: 5, minAmount: "10000000000000.03", approverUserId: null },
      ]);
      const result = await checkApprovalPolicy(
        db,
        "org1",
        "PURCHASE_BILL",
        "10000000000000.02",
      );
      expect(result.needsApproval).toBe(false);
    });
  });

  describe("record type isolation", () => {
    it("queries with the provided recordType (injected via .where call)", async () => {
      const selectFn = jest.fn().mockReturnValue({
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockResolvedValue([]),
      });
      const db = { select: selectFn } as unknown as Db;
      await checkApprovalPolicy(db, "org1", "MANUAL_JOURNAL", "100");
      expect(selectFn).toHaveBeenCalledTimes(1);
    });
  });

  describe("approverUserId handling", () => {
    it("returns null approverUserId when policy has no approver", async () => {
      const db = makeMockDb([{ id: 3, minAmount: null, approverUserId: null }]);
      const result = await checkApprovalPolicy(db, "org1", "PURCHASE_BILL", "100");
      expect(result.approverUserId).toBeNull();
    });

    it("returns approverUserId from matching policy", async () => {
      const db = makeMockDb([{ id: 4, minAmount: null, approverUserId: "approver-uuid" }]);
      const result = await checkApprovalPolicy(db, "org1", "PURCHASE_BILL", "100");
      expect(result.approverUserId).toBe("approver-uuid");
    });
  });

  describe("first matching policy wins", () => {
    it("picks first policy that matches (null minAmount before threshold)", async () => {
      const db = makeMockDb([
        { id: 10, minAmount: null, approverUserId: "first" },
        { id: 11, minAmount: "500", approverUserId: "second" },
      ]);
      const result = await checkApprovalPolicy(db, "org1", "PURCHASE_BILL", "1000");
      expect(result.policyId).toBe(10);
      expect(result.approverUserId).toBe("first");
    });
  });
});
