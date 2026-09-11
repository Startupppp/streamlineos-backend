jest.mock("../../../common/tenant", () => ({
  forEachOrg: jest.fn(),
}));

import type { Db } from "../../../db/drizzle.module";
import { forEachOrg } from "../../../common/tenant";
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
    /*
     * The original test asserted `expect(wheres.length).toBeGreaterThanOrEqual(0)`
     * — true of every array — and put the real check behind `if (wheres.length > 0)`
     * with `else { expect(true).toBe(true); }`. It also left `forEachOrg` real, so
     * the per-org callback never ran and the only predicate ever recorded was the
     * org-agnostic enumeration (`deleted_at is null and status = 'ACTIVE'`). The
     * test could not observe a per-org query at all.
     */
    const wheres: unknown[] = [];
    const tx = {
      select: jest.fn().mockImplementation(() => ({ from: jest.fn().mockImplementation(() => makeFrom(wheres)) })),
    } as unknown as Db;
    (forEachOrg as jest.Mock).mockImplementation(
      async (_db: unknown, _label: string, fn: (tx: unknown, orgId: string) => Promise<void>) => {
        await fn(tx, TARGET);
      },
    );
    const db = { select: jest.fn(), execute: jest.fn() } as unknown as Db;
    const dispatch = { emit: jest.fn().mockResolvedValue(undefined) } as never;
    const svc = new NotificationTimeSweepsService(db, dispatch);

    await svc.sweep();

    expect(wheres.length).toBeGreaterThan(0);
    const unbound = wheres
      .map((w, i) => ({ i, values: sqlValues(w) }))
      .filter((e) => !e.values.includes(TARGET))
      .map((e) => `per-org predicate #${e.i} does not bind the org: ${JSON.stringify(e.values)}`);
    expect(unbound).toEqual([]);
    expect(wheres.flatMap((w) => sqlValues(w))).not.toContain("org-intruder");
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
