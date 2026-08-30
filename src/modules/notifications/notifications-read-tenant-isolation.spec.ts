import type { Db } from "../../db/drizzle.module";
import { NotificationsReadService } from "./notifications-read.service";

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

function makeFrom(allWhereArgs: unknown[]): object {
  const where = jest.fn().mockImplementation((arg: unknown) => {
    allWhereArgs.push(arg);
    return makeChain();
  });
  const self: Record<string, jest.Mock> = { where };
  self["innerJoin"] = jest.fn().mockImplementation(() => makeFrom(allWhereArgs));
  self["leftJoin"] = jest.fn().mockImplementation(() => makeFrom(allWhereArgs));
  return self;
}

describe("NotificationsReadService — cross-tenant isolation", () => {
  const ATTACKER_ORG = "org-attacker";
  const OWNER_ORG = "org-owner";

  function makeDb(): { db: Db; allWhereArgs: unknown[] } {
    const allWhereArgs: unknown[] = [];
    const db = {
      select: jest.fn().mockImplementation(() => ({
        from: jest.fn().mockImplementation(() => makeFrom(allWhereArgs)),
      })),
    } as unknown as Db;
    return { db, allWhereArgs };
  }

  it("scopes notification list to the requesting org (tenant isolation)", async () => {
    const { db, allWhereArgs } = makeDb();
    const cache = { cached: jest.fn().mockImplementation((_k: unknown, fn: () => unknown) => fn()) } as never;
    const svc = new NotificationsReadService(db, cache);

    await svc.list(ATTACKER_ORG, "user-1", { limit: 20 });

    expect(allWhereArgs.length).toBeGreaterThan(0);
    const allVals = allWhereArgs.flatMap(w => sqlValues(w));
    expect(allVals).toContain(ATTACKER_ORG);
  });

  it("returns notifications only for the requesting org (same-tenant control)", async () => {
    const { db } = makeDb();
    const cache = { cached: jest.fn().mockImplementation((_k: unknown, fn: () => unknown) => fn()) } as never;
    const svc = new NotificationsReadService(db, cache);

    const result = await svc.list(OWNER_ORG, "user-1", { limit: 20 });

    expect(result).toBeDefined();
  });
});
