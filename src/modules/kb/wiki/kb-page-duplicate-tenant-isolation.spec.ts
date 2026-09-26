import { NotFoundException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import { KbPageDuplicateService } from "./kb-page-duplicate.service";
import type { PlanLimitsService } from "../../billing/core/plan-limits.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

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

describe("KbPageDuplicateService — cross-tenant isolation", () => {
  const ATTACKER_ORG = "org-attacker";
  const OWNER_ORG = "org-owner";
  const PAGE_ID = 42;

  function makeUser(orgId: string): CurrentUserContext {
    return { orgId, userId: "user-1", isOrgOwner: true } as CurrentUserContext;
  }

  function makeFindFirstDb(returnValue: unknown): { db: Db; findFirst: jest.Mock } {
    const findFirst = jest.fn().mockResolvedValue(returnValue);
    const db = {
      query: {
        kbPages: { findFirst },
      },
      execute: jest.fn().mockResolvedValue([]),
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          innerJoin: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue([]),
          }),
          where: jest.fn().mockReturnValue({
            orderBy: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([]),
            }),
          }),
        }),
      }),
      transaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb({
        select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }) }) }) }),
        insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }) }),
      })),
    } as unknown as Db;
    return { db, findFirst };
  }

  const planLimits = {
    assertWithinLimit: jest.fn(),
  } as unknown as PlanLimitsService;
  const authMock = {
    visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
    assertPageAccess: jest.fn().mockResolvedValue({ orgId: "o1", pageId: 1, action: "view", via: "admin" }),
  };

  it("throws NotFoundException when a caller from a different org requests a page — cross-tenant isolation", async () => {
    const { db, findFirst } = makeFindFirstDb(null);
    const svc = new KbPageDuplicateService(db, planLimits, authMock as never, { commitPageChange: jest.fn().mockResolvedValue(undefined), commitManyPageChanges: jest.fn().mockResolvedValue(undefined) } as never);

    await expect(svc.duplicate(makeUser(ATTACKER_ORG), PAGE_ID)).rejects.toThrow(NotFoundException);

    const callsWithAttackerOrg = findFirst.mock.calls.filter(
      (args) => sqlValues(args[0]?.where).includes(ATTACKER_ORG),
    );
    expect(callsWithAttackerOrg.length).toBeGreaterThan(0);
  });

  it("does not surface NotFoundException from the correct org — same-tenant control", async () => {
    const { db, findFirst } = makeFindFirstDb(null);
    const svc = new KbPageDuplicateService(db, planLimits, authMock as never, { commitPageChange: jest.fn().mockResolvedValue(undefined), commitManyPageChanges: jest.fn().mockResolvedValue(undefined) } as never);

    await expect(svc.duplicate(makeUser(OWNER_ORG), PAGE_ID)).rejects.toThrow(NotFoundException);

    const callsWithOwnerOrg = findFirst.mock.calls.filter(
      (args) => sqlValues(args[0]?.where).includes(OWNER_ORG),
    );
    expect(callsWithOwnerOrg.length).toBeGreaterThan(0);
  });
});
