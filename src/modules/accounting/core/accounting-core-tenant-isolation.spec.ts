import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { AccountingGstService } from "./accounting-gst.service";
import { AccountingLedgerService } from "./accounting-ledger.service";
import { AccountingPayablesService } from "./accounting-payables.service";
import { AccountingStatementsService } from "./accounting-statements.service";
import type { CacheService } from "../../../common/cache/cache.service";
import type { AuditService } from "../../../common/audit/audit.service";
import type { JournalPostingService } from "../posting/journal-posting.service";
import type { FinancePostingService } from "../posting/finance-posting.service";
import type { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import type { AccountingPayablesQueryService } from "./accounting-payables-query.service";
import type { RateResolverService } from "../../finance/controls/rate-resolver.service";
import type { FxService } from "../../finance/controls/fx.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

function makeSelectDb(rows: unknown[]): { db: Db; where: jest.Mock } {
  const where = jest.fn();
  const builder: Record<string, unknown> = {
    limit: jest.fn().mockResolvedValue(rows),
    then: (onFulfilled: (r: unknown[]) => unknown, onRejected?: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(onFulfilled, onRejected),
  };
  const chain = jest.fn().mockReturnValue(builder);
  builder.from = chain;
  builder.leftJoin = chain;
  builder.innerJoin = chain;
  builder.groupBy = chain;
  builder.orderBy = chain;
  builder.offset = chain;
  where.mockReturnValue(builder);
  builder.where = where;
  const db = { select: jest.fn().mockReturnValue(builder) } as unknown as Db;
  return { db, where };
}

const cache = {
  cached: jest.fn().mockImplementation((_k: string, fn: () => Promise<unknown>) => fn()),
  cachedVersioned: jest.fn().mockImplementation(
    (_ns: string, _k: string, fn: () => Promise<unknown>) => fn(),
  ),
  invalidate: jest.fn(),
  invalidateNamespace: jest.fn(),
} as unknown as CacheService;

const audit = { log: jest.fn() } as unknown as AuditService;
const dispatch = { emit: jest.fn() } as unknown as NotificationDispatchService;

describe("accounting core services — cross-tenant isolation", () => {
  describe("AccountingGstService", () => {
    it("gstr1 scopes invoices to the requesting org — DENY returns empty for attacker org", async () => {
      const { db, where } = makeSelectDb([]);
      const svc = new AccountingGstService(db);

      const result = await svc.gstr1("org-attacker", { from: "2024-01-01", to: "2024-01-31" });

      expect(result.grandTotal.invoices).toBe(0);
      expect(where).toHaveBeenCalled();
      expect(sqlValues(where.mock.calls[0]?.[0])).toContain("org-attacker");
    });

    it("gstr1 returns rows for the correct org — CONTROL case", async () => {
      const fakeRow = {
        invoiceId: 1,
        invoiceNumber: "INV-001",
        invoiceDate: "2024-01-15",
        buyerGstin: null,
        subtotal: "1000.0000",
        taxPool: "180.0000",
        total: "1180.0000",
        placeOfSupply: "MH",
        supplierState: "MH",
        isInterState: false,
      };
      const { db } = makeSelectDb([fakeRow]);
      const svc = new AccountingGstService(db);

      const result = await svc.gstr1("org-owner", { from: "2024-01-01", to: "2024-01-31" });
      expect(result).toBeDefined();
    });
  });

  describe("AccountingStatementsService", () => {
    it("balanceSheet scopes to the requesting org — DENY returns zeros for attacker org", async () => {
      const { db, where } = makeSelectDb([]);
      const svc = new AccountingStatementsService(db, cache);

      const result = await svc.balanceSheet("org-attacker", { asOf: "2024-01-31" });

      expect(result.totalAssets).toBe("0.00");
      expect(where).toHaveBeenCalled();
      expect(sqlValues(where.mock.calls[0]?.[0])).toContain("org-attacker");
    });

    it("balanceSheet returns data for the correct org — CONTROL case", async () => {
      const fakeAgg = {
        accountId: 1,
        code: "1100",
        name: "Bank",
        accountType: "ASSET",
        debit: "1000.00",
        credit: "0.00",
      };
      const { db } = makeSelectDb([fakeAgg]);
      const svc = new AccountingStatementsService(db, cache);

      const result = await svc.balanceSheet("org-owner", { asOf: "2024-01-31" });
      expect(result).toBeDefined();
    });
  });

  describe("AccountingLedgerService", () => {
    function makeUpdateReturning(returnRows: unknown[]) {
      const returning = jest.fn().mockResolvedValue(returnRows);
      const whereUpdate = jest.fn().mockReturnValue({ returning });
      const set = jest.fn().mockReturnValue({ where: whereUpdate });
      return { update: jest.fn().mockReturnValue({ set }), whereUpdate };
    }

    it("updateAccount rejects a mutation targeting a different org — DENY case", async () => {
      const { update, whereUpdate } = makeUpdateReturning([]);
      const updateDb = { update } as unknown as Db;
      const svc = new AccountingLedgerService(
        updateDb,
        null as unknown as JournalPostingService,
        null as unknown as FinancePostingService,
        null as unknown as AuditService,
        dispatch,
        null as unknown as CacheService,
      );

      await expect(svc.updateAccount("org-attacker", 42, { name: "Hacked" })).rejects.toThrow(NotFoundException);

      expect(whereUpdate).toHaveBeenCalled();
      expect(sqlValues(whereUpdate.mock.calls[0]?.[0])).toContain("org-attacker");
    });

    it("updateAccount applies the update for the correct org — CONTROL case", async () => {
      const updated = { id: 42, orgId: "org-owner", code: "1100", name: "Bank Updated", accountType: "ASSET", isActive: true };
      const { update } = makeUpdateReturning([updated]);
      const updateDb = { update } as unknown as Db;
      const svc = new AccountingLedgerService(
        updateDb,
        null as unknown as JournalPostingService,
        null as unknown as FinancePostingService,
        null as unknown as AuditService,
        dispatch,
        null as unknown as CacheService,
      );

      const result = await svc.updateAccount("org-owner", 42, { name: "Bank Updated" });
      expect(result).toMatchObject({ id: 42, orgId: "org-owner" });
    });
  });

  describe("AccountingPayablesService", () => {
    function makePayablesService(db: Db): AccountingPayablesService {
      return new AccountingPayablesService(
        db,
        null as unknown as JournalPostingService,
        audit,
        null as unknown as AccountingPayablesQueryService,
        null as unknown as RateResolverService,
        null as unknown as FxService,
      );
    }

    it("updatePurchaseBillStatus hides a bill from a different org — DENY case", async () => {
      const { db, where } = makeSelectDb([]);
      const svc = makePayablesService(db);

      await expect(
        svc.updatePurchaseBillStatus("org-attacker", "user-a", 99, { status: "CANCELLED" }),
      ).rejects.toThrow(NotFoundException);

      expect(where).toHaveBeenCalled();
      expect(sqlValues(where.mock.calls[0]?.[0])).toContain("org-attacker");
    });

    it("updatePurchaseBillStatus cancels a DRAFT bill for the correct org — CONTROL case", async () => {
      const bill = { id: 99, orgId: "org-owner", status: "DRAFT", billNumber: "BILL-001", billDate: "2024-01-15", total: "1000.00" };
      const updateWhere = jest.fn().mockReturnValue({
        then: (r: (v: unknown) => unknown) => Promise.resolve(undefined).then(r),
      });
      const updateSet = jest.fn().mockReturnValue({ where: updateWhere });
      const controlDb = {
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([bill]),
          }),
        }),
        update: jest.fn().mockReturnValue({ set: updateSet }),
      } as unknown as Db;
      const svc = makePayablesService(controlDb);

      await expect(
        svc.updatePurchaseBillStatus("org-owner", "user-a", 99, { status: "CANCELLED" }),
      ).resolves.toMatchObject({ id: 99, status: "CANCELLED" });
    });
  });
});
