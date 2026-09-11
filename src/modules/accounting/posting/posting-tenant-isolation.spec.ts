import { BadRequestException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { FinancePostingService } from "./finance-posting.service";
import { FinancePostingAccountsService } from "./finance-posting-accounts.service";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { journalEntries, journalLines } from "../../../db/schema";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { reverseJournal } from "./lib/journal-reverse";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean")
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

type SelectBuilder = {
  from: jest.Mock;
  where: jest.Mock;
  limit: jest.Mock;
};

function makeSelectDb(rows: unknown[]): { db: Db; builder: SelectBuilder } {
  const builder: SelectBuilder = {
    from: jest.fn(),
    where: jest.fn(),
    limit: jest.fn().mockResolvedValue(rows),
  };
  builder.from.mockReturnValue(builder);
  builder.where.mockReturnValue(builder);
  const db = { select: jest.fn().mockReturnValue(builder) } as unknown as Db;
  return { db, builder };
}

const audit = { log: jest.fn() } as unknown as AuditService;
const cache = { invalidateNamespace: jest.fn() } as unknown as CacheService;
const dispatch = { emit: jest.fn() } as unknown as NotificationDispatchService;
const accountsSvc = {} as FinancePostingAccountsService;

const OWNER_ORG = "org-owner";
const ATTACKER_ORG = "org-attacker";

describe("FinancePostingService — cross-tenant isolation", () => {
  describe("assertEntryNotPosted", () => {
    it("scopes the posted check to the calling org so a POSTED entry in another org does not block the caller", async () => {
      const { db, builder } = makeSelectDb([]);
      const svc = new FinancePostingService(db, accountsSvc, audit, dispatch, cache);

      await expect(svc.assertEntryNotPosted(ATTACKER_ORG, 99)).resolves.toBeUndefined();

      const predicate = builder.where.mock.calls[0]?.[0];
      expect(sqlValues(predicate)).toContain(ATTACKER_ORG);
      expect(sqlValues(predicate)).not.toContain(OWNER_ORG);
    });

    it("blocks a POSTED entry only in the same org (control — same-tenant)", async () => {
      const { db } = makeSelectDb([{ status: "POSTED" }]);
      const svc = new FinancePostingService(db, accountsSvc, audit, dispatch, cache);

      await expect(svc.assertEntryNotPosted(OWNER_ORG, 1)).rejects.toThrow(BadRequestException);
    });

    it("never throws for a POSTED entry in another org, even though entry id matches", async () => {
      const { db } = makeSelectDb([]);
      const svc = new FinancePostingService(db, accountsSvc, audit, dispatch, cache);

      await expect(svc.assertEntryNotPosted(ATTACKER_ORG, 1)).resolves.toBeUndefined();
    });
  });

  describe("assertEntryNotPosted — predicate scope", () => {
    it("always passes both entryId and orgId, never entryId alone", async () => {
      const { db, builder } = makeSelectDb([{ status: "DRAFT" }]);
      const svc = new FinancePostingService(db, accountsSvc, audit, dispatch, cache);

      await svc.assertEntryNotPosted(OWNER_ORG, 42);

      const predicate = builder.where.mock.calls[0]?.[0];
      const vals = sqlValues(predicate);
      expect(vals).toContain(OWNER_ORG);
      expect(vals).toContain(42);
    });
  });

  describe("reverseJournal — line read", () => {
    const CALLER: CurrentUserContext = {
      userId: "u1",
      orgId: OWNER_ORG,
      role: "ADMIN",
      isOrgOwner: false,
      sessionId: "sess1",
      tokenScopes: null,
      principal: humanSessionPrincipal(1, false),
    };

    it("reads the original's lines within the calling org, never by entry id alone", async () => {
      const reads: { table: unknown; where: unknown }[] = [];
      const tx = {
        select: jest.fn().mockImplementation(() => {
          let table: unknown;
          const builder: { from: jest.Mock; where: jest.Mock } = { from: jest.fn(), where: jest.fn() };
          builder.from.mockImplementation((t: unknown) => {
            table = t;
            return builder;
          });
          builder.where.mockImplementation((arg: unknown) => {
            reads.push({ table, where: arg });
            const rows = table === journalEntries ? [{ id: 42, entryNumber: "JE-1", status: "POSTED" }] : [];
            return Object.assign(Promise.resolve(rows), { limit: jest.fn().mockResolvedValue(rows) });
          });
          return builder;
        }),
      };
      const db = {
        transaction: jest.fn((fn: (t: unknown) => Promise<unknown>) => fn(tx)),
      } as unknown as Db;
      const deps = {
        db,
        audit,
        cache,
        assertPeriodOpen: jest.fn().mockResolvedValue(undefined),
        nextSequenceNumber: jest.fn(),
      };

      // The double returns no lines, which ends the reversal before any write.
      await expect(reverseJournal(deps, CALLER, 42)).rejects.toThrow(/no lines to reverse/);

      const lineReads = reads.filter((r) => r.table === journalLines).map((r) => r.where);
      expect(lineReads).toHaveLength(1);
      expect(sqlValues(lineReads[0])).toEqual(expect.arrayContaining([OWNER_ORG, 42]));
    });
  });
});
