import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { AccountingGstService } from "./accounting-gst.service";
import { AccountingLedgerService } from "./accounting-ledger.service";
import { AccountingStatementsService } from "./accounting-statements.service";
import type { CacheService } from "../../../common/cache/cache.service";
import type { AuditService } from "../../../common/audit/audit.service";
import type { JournalPostingService } from "../posting/journal-posting.service";
import type { FinancePostingService } from "../posting/finance-posting.service";
import type { NotificationDispatchService } from "../../notifications/notification-dispatch.service";

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
  const builder: Record<string, unknown> & { then: (r: (v: unknown) => void) => void } = {
    from: jest.fn(),
    leftJoin: jest.fn(),
    innerJoin: jest.fn(),
    where,
    groupBy: jest.fn(),
    orderBy: jest.fn(),
    limit: jest.fn().mockResolvedValue(rows),
    offset: jest.fn(),
    then: (resolve: (v: unknown) => void) => resolve(rows),
  };
  (builder.from as jest.Mock).mockReturnValue(builder);
  (builder.leftJoin as jest.Mock).mockReturnValue(builder);
  (builder.innerJoin as jest.Mock).mockReturnValue(builder);
  (builder.where as jest.Mock).mockReturnValue(builder);
  (builder.groupBy as jest.Mock).mockReturnValue(builder);
  (builder.orderBy as jest.Mock).mockReturnValue(builder);
  (builder.offset as jest.Mock).mockReturnValue(builder);
  const db = {
    select: jest.fn().mockReturnValue(builder),
    execute: jest.fn().mockResolvedValue([]),
  } as unknown as Db;
  return { db, where };
}

const cache = {
  cached: jest.fn().mockImplementation((_k: string, fn: () => Promise<unknown>) => fn()),
  cachedVersioned: jest.fn().mockImplementation((_ns: string, _k: string, fn: () => Promise<unknown>) => fn()),
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

  describe("AccountingLedgerService.listJournal — scope isolation", () => {
    const posting = {
      seedChartOfAccountsForOrg: jest.fn().mockResolvedValue(undefined),
    } as unknown as JournalPostingService;
    const finPosting = {} as unknown as FinancePostingService;

    it("REVOCATION: own scope scopes predicate to membershipId, not userId", async () => {
      const MEMBERSHIP_ID = 42;
      const { db, where } = makeSelectDb([]);
      const svc = new AccountingLedgerService(db, posting, finPosting, audit, dispatch, cache);

      await svc.listJournal("org-owner", { limit: 10 }, "own", "user-1", MEMBERSHIP_ID);

      const predicateValues = sqlValues(where.mock.calls[0]?.[0]);
      expect(predicateValues).toContain(MEMBERSHIP_ID);
    });

    it("DENY: none scope returns empty data array", async () => {
      const { db } = makeSelectDb([]);
      const svc = new AccountingLedgerService(db, posting, finPosting, audit, dispatch, cache);

      const result = await svc.listJournal("org-attacker", { limit: 10 }, "none", "user-1", 0);

      expect(result.data).toHaveLength(0);
    });
  });
});
