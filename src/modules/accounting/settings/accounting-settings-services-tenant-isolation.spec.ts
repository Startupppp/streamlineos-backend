import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { AccountingSettingsService } from "./accounting-settings.service";
import { OpeningBalancesService } from "./opening-balances.service";
import { SystemAccountsService } from "./system-accounts.service";
import type { CacheService } from "../../../common/cache/cache.service";
import type { AuditService } from "../../../common/audit/audit.service";
import type { FinancePostingService } from "../posting/finance-posting.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";

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

function makeBuilder(rows: unknown[]) {
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
  return builder;
}

const cache = {
  cached: jest.fn().mockImplementation((_k: string, fn: () => Promise<unknown>) => fn()),
  cachedVersioned: jest.fn().mockImplementation(
    (_ns: string, _k: string, fn: () => Promise<unknown>) => fn(),
  ),
  invalidate: jest.fn(),
  invalidateNamespace: jest.fn(),
  get: jest.fn(),
  set: jest.fn(),
} as unknown as CacheService;

const audit = { log: jest.fn() } as unknown as AuditService;

function actor(orgId: string): CurrentUserContext {
  return {
    orgId,
    userId: "user-a",
    role: "ADMIN",
    isOrgOwner: false,
    sessionId: "sess-a",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, false),
  };
}

describe("accounting settings services — cross-tenant isolation", () => {
  describe("AccountingSettingsService", () => {
    it("getSettings scopes select to requesting org — DENY never returns another org's data", async () => {
      const where = jest.fn();
      const builder = makeBuilder([]);
      where.mockReturnValue(builder);
      builder.where = where;
      const attackerSettings = { orgId: "org-attacker", baseCurrency: "INR", fiscalYearStartMonth: 4, accountingBasis: "ACCRUAL" };
      const db = {
        select: jest.fn().mockReturnValue(builder),
        insert: jest.fn().mockReturnValue({
          values: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([attackerSettings]),
          }),
        }),
      } as unknown as Db;
      const svc = new AccountingSettingsService(db, cache, audit);

      const result = await svc.getSettings("org-attacker");

      expect(where).toHaveBeenCalled();
      expect(sqlValues(where.mock.calls[0]?.[0])).toContain("org-attacker");
      expect(result?.orgId).toBe("org-attacker");
    });

    it("getSettings returns settings for the correct org — CONTROL case", async () => {
      const settings = { orgId: "org-owner", baseCurrency: "INR", fiscalYearStartMonth: 4, accountingBasis: "ACCRUAL" };
      const where = jest.fn();
      const builder = makeBuilder([settings]);
      where.mockReturnValue(builder);
      builder.where = where;
      const db = { select: jest.fn().mockReturnValue(builder) } as unknown as Db;
      const svc = new AccountingSettingsService(db, cache, audit);

      const result = await svc.getSettings("org-owner");
      expect(result).toMatchObject({ orgId: "org-owner" });
    });
  });

  describe("OpeningBalancesService", () => {
    it("getOpeningBalance scopes to requesting org — DENY when attacker org has no opening balance", async () => {
      const where = jest.fn();
      const builder = makeBuilder([]);
      where.mockReturnValue(builder);
      builder.where = where;
      const db = { select: jest.fn().mockReturnValue(builder) } as unknown as Db;
      const posting = {} as FinancePostingService;
      const svc = new OpeningBalancesService(db, posting, cache, audit);

      const result = await svc.getOpeningBalance("org-attacker");

      expect(result).toMatchObject({ posted: false, entry: null });
      expect(where).toHaveBeenCalled();
      expect(sqlValues(where.mock.calls[0]?.[0])).toContain("org-attacker");
    });

    it("getOpeningBalance returns the balance for the correct org — CONTROL case", async () => {
      const entry = { id: 1, orgId: "org-owner", entryNumber: "OB-01", status: "POSTED", sourceType: "OPENING_BALANCE" };
      const firstWhere = jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([entry]) });
      const firstBuilder = { from: jest.fn().mockReturnThis(), where: firstWhere };
      const lineBuilder = makeBuilder([]);
      const lineWhere = jest.fn().mockReturnValue(lineBuilder);
      lineBuilder.where = lineWhere;
      const lineFrom = jest.fn().mockReturnValue({ innerJoin: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }) });
      const db = {
        select: jest.fn()
          .mockReturnValueOnce(firstBuilder)
          .mockReturnValue({ from: lineFrom }),
      } as unknown as Db;

      const posting = {} as FinancePostingService;
      const svc = new OpeningBalancesService(db, posting, cache, audit);

      const result = await svc.getOpeningBalance("org-owner");
      expect(result).toMatchObject({ posted: true });
    });
  });

  describe("SystemAccountsService", () => {
    it("upsertSystemAccount rejects account from a different org — DENY case", async () => {
      const where = jest.fn();
      const builder = makeBuilder([]);
      where.mockReturnValue(builder);
      builder.where = where;
      const db = { select: jest.fn().mockReturnValue(builder) } as unknown as Db;
      const svc = new SystemAccountsService(db, cache, audit);

      await expect(
        svc.upsertSystemAccount(actor("org-attacker"), "AR", { accountId: 99 }),
      ).rejects.toThrow(NotFoundException);

      expect(where).toHaveBeenCalled();
      expect(sqlValues(where.mock.calls[0]?.[0])).toContain("org-attacker");
    });

    it("upsertSystemAccount accepts a valid account for the correct org — CONTROL case", async () => {
      const account = { id: 99, accountType: "ASSET", orgId: "org-owner" };
      const where = jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([account]) });
      const db = {
        select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnThis(), where }),
        insert: jest.fn().mockReturnValue({
          values: jest.fn().mockReturnValue({
            onConflictDoUpdate: jest.fn().mockResolvedValue([]),
          }),
        }),
        delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
      } as unknown as Db;

      const svc = new SystemAccountsService(db, cache, audit);
      await expect(svc.upsertSystemAccount(actor("org-owner"), "AR", { accountId: 99 })).resolves.not.toThrow();
    });
  });
});
