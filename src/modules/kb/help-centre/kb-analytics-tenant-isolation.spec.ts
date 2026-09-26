import { sql } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import { KbAnalyticsService } from "./kb-analytics.service";

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

function makeChain(rows: unknown[] = []): object {
  return Object.assign(Promise.resolve(rows), {
    limit: jest.fn().mockImplementation(() => makeChain(rows)),
    offset: jest.fn().mockImplementation(() => makeChain(rows)),
    orderBy: jest.fn().mockImplementation(() => makeChain(rows)),
    groupBy: jest.fn().mockImplementation(() => makeChain(rows)),
  });
}

function makeDb(): { db: Db; allWhereArgs: unknown[] } {
  const allWhereArgs: unknown[] = [];
  const db = {
    select: jest.fn().mockImplementation(() => ({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockImplementation((arg: unknown) => {
          allWhereArgs.push(arg);
          return makeChain([{ totalCount: 0, publishedCount: 0, archivedCount: 0, totalViews: 0, helpfulUp: 0, helpfulDown: 0, verifiedPublished: 0 }]);
        }),
        leftJoin: jest.fn().mockReturnValue({
          where: jest.fn().mockImplementation((arg: unknown) => {
            allWhereArgs.push(arg);
            return makeChain([]);
          }),
        }),
      }),
    })),
  } as unknown as Db;
  return { db, allWhereArgs };
}

const auth = {
  visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
  assertPageAccess: jest.fn().mockResolvedValue({ orgId: "org-1", pageId: 1, action: "view", via: "admin" }),
};

describe("KbAnalyticsService — cross-tenant isolation", () => {
  const ATTACKER_ORG = "org-attacker";
  const OWNER_ORG = "org-owner";

  it("scopes all analytics queries to the requesting org (tenant isolation)", async () => {
    const { db, allWhereArgs } = makeDb();
    const svc = new KbAnalyticsService(db, auth as never);

    await svc.overview(ATTACKER_ORG, {}).catch(() => {});

    expect(allWhereArgs.length).toBeGreaterThan(0);
    const allVals = allWhereArgs.flatMap(w => sqlValues(w));
    expect(allVals).toContain(ATTACKER_ORG);
    expect(allVals).not.toContain(OWNER_ORG);
  });

  it("does not leak data across orgs (same-tenant control)", async () => {
    const { db, allWhereArgs } = makeDb();
    const svc = new KbAnalyticsService(db, auth as never);

    await svc.overview(OWNER_ORG, {}).catch(() => {});

    const allVals = allWhereArgs.flatMap(w => sqlValues(w));
    expect(allVals).toContain(OWNER_ORG);
    expect(allVals).not.toContain(ATTACKER_ORG);
  });
});
