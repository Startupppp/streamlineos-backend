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

function makeSelectDb(rows: unknown[]): { db: Db; where: jest.Mock } {
  const where = jest.fn();
  const builder: Record<string, unknown> & { then: (r: (v: unknown) => void) => void } = {
    from: jest.fn(),
    leftJoin: jest.fn(),
    innerJoin: jest.fn(),
    where,
    orderBy: jest.fn(),
    groupBy: jest.fn(),
    limit: jest.fn().mockResolvedValue(rows),
    offset: jest.fn(),
    then: (resolve: (v: unknown) => void) => resolve(rows),
  };
  (builder.from as jest.Mock).mockReturnValue(builder);
  (builder.leftJoin as jest.Mock).mockReturnValue(builder);
  (builder.innerJoin as jest.Mock).mockReturnValue(builder);
  (builder.where as jest.Mock).mockReturnValue(builder);
  (builder.orderBy as jest.Mock).mockReturnValue(builder);
  (builder.groupBy as jest.Mock).mockReturnValue(builder);
  (builder.offset as jest.Mock).mockReturnValue(builder);
  const insertChain = {
    values: jest.fn().mockReturnThis(),
    onConflictDoUpdate: jest.fn().mockReturnThis(),
    returning: jest.fn().mockResolvedValue([]),
  };
  const db = {
    select: jest.fn().mockReturnValue(builder),
    insert: jest.fn().mockReturnValue(insertChain),
    execute: jest.fn().mockResolvedValue([]),
  } as unknown as Db;
  return { db, where };
}

const cache = {
  cached: jest.fn().mockImplementation((_k: string, fn: () => Promise<unknown>) => fn()),
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
    it("getSettings scopes to requesting org — DENY returns null/defaults for attacker", async () => {
      const { db, where } = makeSelectDb([]);
      const svc = new AccountingSettingsService(db, cache, audit);

      const result = await svc.getSettings("org-attacker");

      expect(where).toHaveBeenCalled();
      expect(sqlValues(where.mock.calls[0]?.[0])).toContain("org-attacker");
      expect(result).toBeUndefined();
    });

    it("getSettings returns settings for the correct org — CONTROL case", async () => {
      const settings = { orgId: "org-owner", baseCurrency: "INR", fiscalYearStartMonth: 4 };
      const { db } = makeSelectDb([settings]);
      const svc = new AccountingSettingsService(db, cache, audit);

      const result = await svc.getSettings("org-owner");
      expect(result).toBeDefined();
    });
  });

  describe("OpeningBalancesService", () => {
    it("getOpeningBalance scopes to requesting org — DENY returns null for attacker org", async () => {
      const { db, where } = makeSelectDb([]);
      const posting = {} as FinancePostingService;
      const svc = new OpeningBalancesService(db, posting, cache, audit);

      const result = await svc.getOpeningBalance("org-attacker");

      expect(result.posted).toBe(false);
      expect(result.entry).toBeNull();
      expect(where).toHaveBeenCalled();
      expect(sqlValues(where.mock.calls[0]?.[0])).toContain("org-attacker");
    });

    it("getOpeningBalance returns the balance for the correct org — CONTROL case", async () => {
      const entry = { id: 1, orgId: "org-owner", entryNumber: "OB-01", status: "POSTED" };
      const lineBuilder = {
        from: jest.fn().mockReturnThis(),
        leftJoin: jest.fn().mockReturnThis(),
        innerJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockResolvedValue([]),
        orderBy: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([entry]),
      };
      const db = {
        select: jest.fn()
          .mockReturnValueOnce({ from: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(), limit: jest.fn().mockResolvedValue([entry]) })
          .mockReturnValue(lineBuilder),
      } as unknown as Db;

      const posting = {} as FinancePostingService;
      const svc = new OpeningBalancesService(db, posting, cache, audit);

      const result = await svc.getOpeningBalance("org-owner");
      expect(result).toBeDefined();
    });
  });

  describe("SystemAccountsService", () => {
    it("upsertSystemAccount rejects account from a different org — DENY case", async () => {
      const { db, where } = makeSelectDb([]);
      const svc = new SystemAccountsService(db, cache, audit);

      await expect(
        svc.upsertSystemAccount(actor("org-attacker"), "AR", { accountId: 99 }),
      ).rejects.toThrow(NotFoundException);

      expect(where).toHaveBeenCalled();
      expect(sqlValues(where.mock.calls[0]?.[0])).toContain("org-attacker");
    });

    it("upsertSystemAccount accepts a valid account for the correct org — CONTROL case", async () => {
      const account = { id: 99, accountType: "ASSET", orgId: "org-owner" };
      const insertChain = {
        values: jest.fn().mockReturnThis(),
        onConflictDoUpdate: jest.fn().mockResolvedValue([]),
      };
      const db = {
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          limit: jest.fn().mockResolvedValue([account]),
        }),
        insert: jest.fn().mockReturnValue(insertChain),
        delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
      } as unknown as Db;

      const svc = new SystemAccountsService(db, cache, audit);
      await expect(svc.upsertSystemAccount(actor("org-owner"), "AR", { accountId: 99 })).resolves.not.toThrow();
    });
  });
});
