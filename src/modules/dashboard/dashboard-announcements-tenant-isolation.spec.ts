import type { Db } from "../../db/drizzle.module";
import { DashboardAnnouncementsService } from "./dashboard-announcements.service";

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
    where: jest.fn().mockImplementation(() => makeChain(rows)),
  });
}

describe("DashboardAnnouncementsService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  function makeDb(): { db: Db; wheres: unknown[] } {
    const wheres: unknown[] = [];
    const joinResult = { where: jest.fn().mockImplementation((a: unknown) => { wheres.push(a); return makeChain(); }) };
    const db = {
      select: jest.fn().mockImplementation(() => ({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockImplementation((a: unknown) => { wheres.push(a); return makeChain(); }),
          leftJoin: jest.fn().mockReturnValue(joinResult),
          innerJoin: jest.fn().mockReturnValue(joinResult),
        }),
      })),
    } as unknown as Db;
    return { db, wheres };
  }

  it("scopes announcement list to the requesting org (tenant isolation)", async () => {
    const { db, wheres } = makeDb();
    const cache = {
      cachedForOrg: jest
        .fn()
        .mockImplementation((_orgId: unknown, _k: unknown, fn: () => unknown) => fn()),
    } as never;
    const access = { holds: jest.fn().mockResolvedValue(true) } as never;
    const svc = new DashboardAnnouncementsService(db, cache, access);

    await svc.getActiveAnnouncements(ATTACKER);

    expect(wheres.length).toBeGreaterThan(0);
    expect(wheres.flatMap(w => sqlValues(w))).toContain(ATTACKER);
  });

  it("returns announcements for the owning org (same-tenant control)", async () => {
    const { db } = makeDb();
    const cache = {
      cachedForOrg: jest
        .fn()
        .mockImplementation((_orgId: unknown, _k: unknown, fn: () => unknown) => fn()),
    } as never;
    const access = { holds: jest.fn().mockResolvedValue(true) } as never;
    const svc = new DashboardAnnouncementsService(db, cache, access);

    const result = await svc.getActiveAnnouncements(OWNER);

    expect(result).toBeDefined();
  });
});
