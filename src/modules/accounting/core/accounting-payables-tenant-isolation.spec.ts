jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: jest.fn(),
}));

import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { AccountingPayablesService } from "./accounting-payables.service";
import type { JournalPostingService } from "../posting/journal-posting.service";
import type { AuditService } from "../../../common/audit/audit.service";
import type { AccountingPayablesQueryService } from "./accounting-payables-query.service";
import type { RateResolverService } from "../../finance/controls/rate-resolver.service";
import type { FxService } from "../../finance/controls/fx.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

const ATTACKER_ORG = "org-attacker";
const OWNER_ORG = "org-owner";

const BILL_ROW = {
  id: 1,
  orgId: OWNER_ORG,
  status: "DRAFT",
  total: "100.0000",
  amountPaid: null,
  billNumber: "BILL-2024-0001",
  billDate: "2024-01-01",
  supplierGstin: null,
  placeOfSupply: null,
  expenseAccountCode: "5000",
  currency: "INR",
  exchangeRate: "1",
  discount: "0.0000",
  subtotal: "100.0000",
  taxAmount: "0.0000",
  cgstAmount: "0.0000",
  sgstAmount: "0.0000",
  igstAmount: "0.0000",
};

function makeDeps() {
  return {
    posting: {
      seedChartOfAccountsForOrg: jest.fn().mockResolvedValue(undefined),
      postPurchaseBill: jest.fn().mockResolvedValue(undefined),
      postVendorPayment: jest.fn().mockResolvedValue(undefined),
    } as unknown as JournalPostingService,
    audit: { log: jest.fn() } as unknown as AuditService,
    query: {} as unknown as AccountingPayablesQueryService,
    rateResolver: {} as unknown as RateResolverService,
    fx: {} as unknown as FxService,
  };
}

function makeSelectDb(rows: unknown[]): { db: Db; where: jest.Mock } {
  const limit = jest.fn().mockResolvedValue(rows);
  const where = jest.fn().mockReturnValue({ limit });
  const from = jest.fn().mockReturnValue({ where });
  const db = {
    select: jest.fn().mockReturnValue({ from }),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
    }),
    transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
  } as unknown as Db;
  return { db, where };
}

beforeEach(() => {
  jest.resetAllMocks();
});

describe("AccountingPayablesService — cross-tenant isolation", () => {
  describe("updatePurchaseBillStatus", () => {
    it("throws NotFoundException when bill belongs to a different org (DENY)", async () => {
      const { db } = makeSelectDb([]);
      const { posting, audit, query, rateResolver, fx } = makeDeps();
      const svc = new AccountingPayablesService(db, posting, audit, query, rateResolver, fx);
      await expect(
        svc.updatePurchaseBillStatus(ATTACKER_ORG, "user-1", 1, { status: "CANCELLED" }),
      ).rejects.toThrow(NotFoundException);
    });

    it("scopes the lookup query to the requesting orgId (predicate check)", async () => {
      const { db, where } = makeSelectDb([]);
      const { posting, audit, query, rateResolver, fx } = makeDeps();
      const svc = new AccountingPayablesService(db, posting, audit, query, rateResolver, fx);
      await expect(
        svc.updatePurchaseBillStatus(ATTACKER_ORG, "user-1", 1, { status: "CANCELLED" }),
      ).rejects.toThrow(NotFoundException);
      expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER_ORG);
    });

    it("succeeds when bill belongs to the requesting org (CONTROL)", async () => {
      const { db } = makeSelectDb([BILL_ROW]);
      const { posting, audit, query, rateResolver, fx } = makeDeps();
      const svc = new AccountingPayablesService(db, posting, audit, query, rateResolver, fx);
      const result = await svc.updatePurchaseBillStatus(OWNER_ORG, "user-1", 1, { status: "CANCELLED" });
      expect(result).toMatchObject({ id: 1, status: "CANCELLED" });
    });
  });

  describe("recordBillPayment", () => {
    it("throws NotFoundException when bill belongs to a different org (DENY)", async () => {
      const { db } = makeSelectDb([]);
      const { posting, audit, query, rateResolver, fx } = makeDeps();
      const svc = new AccountingPayablesService(db, posting, audit, query, rateResolver, fx);
      await expect(
        svc.recordBillPayment(ATTACKER_ORG, "user-1", 1, {
          amount: 50,
          paymentDate: "2024-01-15",
          paymentMethod: "bank_transfer",
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it("scopes the lookup query to the requesting orgId (predicate check)", async () => {
      const { db, where } = makeSelectDb([]);
      const { posting, audit, query, rateResolver, fx } = makeDeps();
      const svc = new AccountingPayablesService(db, posting, audit, query, rateResolver, fx);
      await expect(
        svc.recordBillPayment(ATTACKER_ORG, "user-1", 1, {
          amount: 50,
          paymentDate: "2024-01-15",
          paymentMethod: "bank_transfer",
        }),
      ).rejects.toThrow(NotFoundException);
      expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER_ORG);
    });

    it("processes payment for the owning org (CONTROL)", async () => {
      const paymentRow = { id: 10, orgId: OWNER_ORG, billId: 1, amount: "50.00" };
      const { posting, audit, query, rateResolver, fx } = makeDeps();
      const postedBill = { ...BILL_ROW, status: "POSTED" };
      /*
       * Two reads happen inside the transaction: the bill row taken FOR UPDATE
       * (the lock that serialises two concurrent payments), then the sum of
       * vendor_payments. `where` therefore has to be awaitable AND carry `.for`.
       */
      const forMode = jest.fn();
      const txWhere = jest.fn().mockImplementation(() =>
        Object.assign(Promise.resolve([{ paid: "50.00" }]), {
          for: (mode: string) => {
            forMode(mode);
            return { limit: jest.fn().mockResolvedValue([postedBill]) };
          },
        }),
      );
      const mockTx = {
        insert: jest.fn().mockReturnValue({
          values: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([paymentRow]),
          }),
        }),
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({ where: txWhere }),
        }),
        update: jest.fn().mockReturnValue({
          set: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue(undefined),
          }),
        }),
      };
      const limit = jest.fn().mockResolvedValue([postedBill]);
      const where = jest.fn().mockReturnValue({ limit });
      const from = jest.fn().mockReturnValue({ where });
      const db = {
        select: jest.fn().mockReturnValue({ from }),
        transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(mockTx)),
      } as unknown as Db;
      const svc = new AccountingPayablesService(db, posting, audit, query, rateResolver, fx);
      const result = await svc.recordBillPayment(OWNER_ORG, "user-1", 1, {
        amount: 50,
        paymentDate: "2024-01-15",
        paymentMethod: "bank_transfer",
      });
      expect(result).toMatchObject({ id: 10 });
      // Without the row lock the sufficiency check is check-then-act and two
      // full payments on one bill both commit.
      expect(forMode).toHaveBeenCalledWith("update");
      expect(sqlValues(txWhere.mock.calls[0]?.[0])).toContain(OWNER_ORG);
    });
  });
});
