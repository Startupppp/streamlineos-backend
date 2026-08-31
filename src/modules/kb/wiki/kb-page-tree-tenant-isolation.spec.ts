import type { Db } from "../../../db/drizzle.module";
import { KbPageTreeService } from "./kb-page-tree.service";

function sqlValues(v: unknown, seen = new Set<object>()): unknown[] {
  if (v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return [v];
  if (Array.isArray(v)) return v.flatMap(i => sqlValues(i, seen));
  if (typeof v !== "object" || seen.has(v)) return [];
  seen.add(v);
  const r = v as { queryChunks?: unknown[]; value?: unknown };
  return [...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []), ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : [])];
}

describe("KbPageTreeService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  function makeUser(orgId: string) {
    return { orgId, userId: "user-1", isOrgOwner: false } as never;
  }

  const audit = {} as never;

  function makeDb() {
    const wheres: unknown[] = [];
    return {
      db: {
        select: jest.fn().mockImplementation(() => ({
          from: jest.fn().mockImplementation(() => ({
            innerJoin: jest.fn().mockReturnValue({
              where: jest.fn().mockImplementation((w: unknown) => {
                wheres.push(w);
                return Promise.resolve([]);
              }),
            }),
            where: jest.fn().mockImplementation((w: unknown) => {
              wheres.push(w);
              return Object.assign(Promise.resolve([]), {
                orderBy: jest.fn().mockReturnValue(Object.assign(Promise.resolve([]), { limit: jest.fn().mockResolvedValue([]) })),
              });
            }),
          })),
        })),
      } as unknown as Db,
      wheres,
    };
  }

  it("scopes page tree query to the requesting org (cross-tenant isolation)", async () => {
    const { db, wheres } = makeDb();
    const svc = new KbPageTreeService(db, audit);

    await svc.getTree(makeUser(ATTACKER));

    expect(wheres.length).toBeGreaterThan(0);
    const vals = wheres.flatMap(w => sqlValues(w));
    expect(vals).toContain(ATTACKER);
    expect(vals).not.toContain(OWNER);
  });

  it("returns page tree for the owning org (same-tenant control)", async () => {
    const { db } = makeDb();
    const svc = new KbPageTreeService(db, audit);

    const result = await svc.getTree(makeUser(OWNER));

    expect(Array.isArray(result)).toBe(true);
  });
});
