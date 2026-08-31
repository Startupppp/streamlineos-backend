import { BadRequestException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { FinancePostingService } from "./finance-posting.service";
import { FinancePostingAccountsService } from "./finance-posting-accounts.service";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";

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

describe("journal immutability — posted entries reject mutation", () => {
  it("assertEntryNotPosted throws when entry is POSTED", async () => {
    const { db } = makeSelectDb([{ status: "POSTED" }]);
    const svc = new FinancePostingService(db, accountsSvc, audit, dispatch, cache);

    await expect(svc.assertEntryNotPosted("org-a", 1)).rejects.toThrow(BadRequestException);
    await expect(svc.assertEntryNotPosted("org-a", 1)).rejects.toThrow(
      "Cannot mutate a POSTED journal entry",
    );
  });

  it("assertEntryNotPosted allows mutation when entry is DRAFT", async () => {
    const { db } = makeSelectDb([{ status: "DRAFT" }]);
    const svc = new FinancePostingService(db, accountsSvc, audit, dispatch, cache);

    await expect(svc.assertEntryNotPosted("org-a", 1)).resolves.toBeUndefined();
  });

  it("assertEntryNotPosted allows mutation when entry is PENDING_APPROVAL", async () => {
    const { db } = makeSelectDb([{ status: "PENDING_APPROVAL" }]);
    const svc = new FinancePostingService(db, accountsSvc, audit, dispatch, cache);

    await expect(svc.assertEntryNotPosted("org-a", 1)).resolves.toBeUndefined();
  });

  it("assertEntryNotPosted scopes the lookup to the correct org", async () => {
    const { db, builder } = makeSelectDb([]);
    const svc = new FinancePostingService(db, accountsSvc, audit, dispatch, cache);

    await svc.assertEntryNotPosted("org-target", 42);

    expect(builder.where).toHaveBeenCalledTimes(1);
    expect(sqlValues(builder.where.mock.calls[0]?.[0])).toContain("org-target");
  });

  it("cross-tenant: assertEntryNotPosted for org-a never sees org-b's POSTED entry", async () => {
    const orgB = "org-b";
    const orgA = "org-a";

    const selectCalls: string[] = [];
    const builder: SelectBuilder = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockImplementation(function (this: SelectBuilder, cond: unknown) {
        selectCalls.push(JSON.stringify(sqlValues(cond)));
        return this;
      }),
      limit: jest.fn().mockResolvedValue([]),
    };
    const db = { select: jest.fn().mockReturnValue(builder) } as unknown as Db;

    const svc = new FinancePostingService(db, accountsSvc, audit, dispatch, cache);
    await svc.assertEntryNotPosted(orgA, 1);

    expect(selectCalls.every((c) => c.includes(orgA))).toBe(true);
    expect(selectCalls.some((c) => c.includes(orgB))).toBe(false);
  });
});
