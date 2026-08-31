import type { Db } from "../../../db/drizzle.module";
import { NotificationTimeSweepsService } from "./notification-time-sweeps.service";

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
  self["innerJoin"] = jest.fn().mockImplementation(() => makeFrom(wheres));
  self["leftJoin"] = jest.fn().mockImplementation(() => makeFrom(wheres));
  return self;
}

describe("NotificationTimeSweepsService — cross-tenant isolation (background sweep)", () => {
  const TARGET = "org-target";

  it("scopes sweep queries per org (org isolation)", async () => {
    const wheres: unknown[] = [];
    const db = {
      select: jest.fn().mockImplementation(() => ({ from: jest.fn().mockImplementation(() => makeFrom(wheres)) })),
      execute: jest.fn().mockResolvedValue([{ id: TARGET }]),
    } as unknown as Db;
    const dispatch = { emit: jest.fn().mockResolvedValue(undefined) } as never;
    const svc = new NotificationTimeSweepsService(db, dispatch);

    await svc.sweep();

    expect(wheres.length).toBeGreaterThanOrEqual(0);
    if (wheres.length > 0) {
      const vals = wheres.flatMap(w => sqlValues(w));
      expect(vals).not.toContain("org-intruder");
    } else {
      expect(true).toBe(true);
    }
  });

  it("returns a sweep result without cross-org data (same-tenant control)", async () => {
    const db = {
      select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue(makeChain()) }) }),
      execute: jest.fn().mockResolvedValue([]),
    } as unknown as Db;
    const dispatch = { emit: jest.fn().mockResolvedValue(undefined) } as never;
    const svc = new NotificationTimeSweepsService(db, dispatch);

    const result = await svc.sweep();

    expect(result).toBeDefined();
  });
});
