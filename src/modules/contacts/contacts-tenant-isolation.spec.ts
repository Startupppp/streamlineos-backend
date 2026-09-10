import { ScopedRead } from "../access/scoped-read";
import type { Db } from "../../db/drizzle.module";
import { ContactsService } from "./contacts.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const rec = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(rec.queryChunks ? sqlValues(rec.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(rec, "value") ? sqlValues(rec.value, seen) : []),
  ];
}

function makeDb(rows: unknown[]): { db: Db; where: jest.Mock } {
  const where = jest.fn();
  const chain: Record<string, unknown> = {
    then: (fn: (v: unknown) => unknown) => Promise.resolve(rows).then(fn),
    catch: (fn: (e: unknown) => unknown) => Promise.resolve(rows).catch(fn),
    finally: (fn: () => void) => Promise.resolve(rows).finally(fn),
    where,
  };
  for (const m of ["orderBy", "limit", "offset", "groupBy", "having", "leftJoin", "innerJoin"]) {
    chain[m] = jest.fn().mockReturnValue(chain);
  }
  where.mockReturnValue(chain);
  const from = jest.fn().mockReturnValue(chain);
  const db = { select: jest.fn().mockReturnValue({ from }) } as unknown as Db;
  return { db, where };
}

const ATTACKER = "org-attacker";
const OWNER = "org-owner";

describe("ContactsService — cross-tenant isolation", () => {
  function buildSvc(db: Db) {
    const cache = {
      cached: jest.fn().mockImplementation((_k: unknown, fn: () => Promise<unknown>) => fn()),
      cachedVersioned: jest.fn().mockImplementation((_k: unknown, _h: unknown, fn: () => Promise<unknown>) => fn()),
      invalidateNamespace: jest.fn().mockResolvedValue(undefined),
    };
    const planLimits = { assertWithinLimit: jest.fn().mockResolvedValue(undefined) };
    return new ContactsService(db, cache as never, planLimits as never);
  }

  it("search: returns nothing for a different org (cross-tenant isolation deny)", async () => {
    const { db, where } = makeDb([]);
    const svc = buildSvc(db);
    const result = await svc.search(ScopedRead.of(ATTACKER, "user-attacker", "all"), "Alice");
    expect(result).toHaveLength(0);
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
  });

  it("search: returns rows for the owning org (control)", async () => {
    const row = { id: 1, orgId: OWNER, name: "Alice", email: "alice@owner.com" };
    const { db } = makeDb([row]);
    const svc = buildSvc(db);
    const result = await svc.search(ScopedRead.of(OWNER, "user-owner", "all"), "Alice");
    expect(result).toHaveLength(1);
  });
});
