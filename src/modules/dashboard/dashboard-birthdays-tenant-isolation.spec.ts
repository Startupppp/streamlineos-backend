import type { Db } from "../../db/drizzle.module";
import { DashboardBirthdaysService } from "./dashboard-birthdays.service";

function sqlValues(v: unknown, seen = new Set<object>()): unknown[] {
  if (v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return [v];
  if (Array.isArray(v)) return v.flatMap(i => sqlValues(i, seen));
  if (typeof v !== "object" || seen.has(v)) return [];
  seen.add(v);
  const r = v as { queryChunks?: unknown[]; value?: unknown };
  return [...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []), ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : [])];
}

function makeChain(rows: unknown[] = []): object {
  return Object.assign(Promise.resolve(rows), {
    limit: jest.fn().mockImplementation(() => makeChain(rows)),
    orderBy: jest.fn().mockImplementation(() => makeChain(rows)),
    groupBy: jest.fn().mockImplementation(() => makeChain(rows)),
  });
}

function makeFrom(wheres: unknown[]): object {
  const where = jest.fn().mockImplementation((a: unknown) => { wheres.push(a); return makeChain(); });
  const self: Record<string, jest.Mock> = { where };
  self["leftJoin"] = jest.fn().mockImplementation(() => makeFrom(wheres));
  self["innerJoin"] = jest.fn().mockImplementation(() => makeFrom(wheres));
  return self;
}

describe("DashboardBirthdaysService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  function makeDb(): { db: Db; wheres: unknown[] } {
    const wheres: unknown[] = [];
    const db = {
      select: jest.fn().mockImplementation(() => ({ from: jest.fn().mockImplementation(() => makeFrom(wheres)) })),
    } as unknown as Db;
    return { db, wheres };
  }

  it("scopes birthday query to the requesting org (tenant isolation)", async () => {
    const { db, wheres } = makeDb();
    const cache = { cachedForOrg: jest.fn().mockImplementation((_orgId: unknown, _k: unknown, fn: () => unknown) => fn()) } as never;
    const access = { holds: jest.fn().mockResolvedValue(true), getPermissionsVersion: jest.fn().mockResolvedValue(1) } as never;
    const svc = new DashboardBirthdaysService(db, cache, access);

    await svc.getBirthdays(ATTACKER);

    expect(wheres.length).toBeGreaterThan(0);
    expect(wheres.flatMap(w => sqlValues(w))).toContain(ATTACKER);
  });

  it("returns birthdays for the owning org (same-tenant control)", async () => {
    const { db } = makeDb();
    const cache = { cachedForOrg: jest.fn().mockImplementation((_orgId: unknown, _k: unknown, fn: () => unknown) => fn()) } as never;
    const access = { holds: jest.fn().mockResolvedValue(true), getPermissionsVersion: jest.fn().mockResolvedValue(1) } as never;
    const svc = new DashboardBirthdaysService(db, cache, access);

    const result = await svc.getBirthdays(OWNER);

    expect(result).toBeInstanceOf(Array);
  });
});
