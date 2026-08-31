import type { Db } from "../../db/drizzle.module";
import { NotificationProvidersService } from "./notification-providers.service";

function sqlValues(v: unknown, seen = new Set<object>()): unknown[] {
  if (v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return [v];
  if (Array.isArray(v)) return v.flatMap(i => sqlValues(i, seen));
  if (typeof v !== "object" || seen.has(v)) return [];
  seen.add(v);
  const r = v as { queryChunks?: unknown[]; value?: unknown };
  return [...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []), ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : [])];
}

describe("NotificationProvidersService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  function makeDb(rows: unknown[]): { db: Db; wheres: unknown[] } {
    const wheres: unknown[] = [];
    const findMany = jest.fn().mockImplementation(({ where: w }: { where?: unknown }) => { if (w) wheres.push(w); return Promise.resolve(rows); });
    const db = {
      query: {
        notificationProviderAccounts: { findMany, findFirst: jest.fn().mockResolvedValue(null) },
      },
    } as unknown as Db;
    return { db, wheres };
  }

  it("scopes provider list to the requesting org (tenant isolation)", async () => {
    const { db, wheres } = makeDb([]);
    const cache = { cached: jest.fn().mockImplementation((_k: unknown, fn: () => unknown) => fn()) } as never;
    const registry = { getProvider: jest.fn() } as never;
    const svc = new NotificationProvidersService(db, cache, registry);

    await svc.list(ATTACKER);

    expect(wheres.length).toBeGreaterThan(0);
    expect(wheres.flatMap(w => sqlValues(w))).toContain(ATTACKER);
  });

  it("returns providers for the owning org (same-tenant control)", async () => {
    const { db } = makeDb([{ id: 1, orgId: OWNER }]);
    const cache = { cached: jest.fn().mockImplementation((_k: unknown, fn: () => unknown) => fn()) } as never;
    const registry = { getProvider: jest.fn() } as never;
    const svc = new NotificationProvidersService(db, cache, registry);

    const result = await svc.list(OWNER);

    expect(result).toHaveLength(1);
  });
});
