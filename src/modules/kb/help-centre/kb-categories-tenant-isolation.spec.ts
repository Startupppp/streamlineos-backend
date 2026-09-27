import type { Db } from "../../../db/drizzle.module";
import { KbCategoriesService } from "./kb-categories.service";

function sqlValues(v: unknown, seen = new Set<object>()): unknown[] {
  if (v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return [v];
  if (Array.isArray(v)) return v.flatMap(i => sqlValues(i, seen));
  if (typeof v !== "object" || seen.has(v)) return [];
  seen.add(v);
  const r = v as { queryChunks?: unknown[]; value?: unknown };
  return [...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []), ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : [])];
}

describe("KbCategoriesService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const SPACE_ID = 2;

  function makeUser(orgId: string) {
    return { orgId, userId: "user-1", isOrgOwner: false } as never;
  }

  const access = { assertSpaceAccessible: jest.fn().mockResolvedValue(undefined) } as never;

  function makeDb() {
    const wheres: unknown[] = [];
    return {
      db: {
        select: jest.fn().mockImplementation(() => ({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockImplementation((w: unknown) => {
              wheres.push(w);
              return {
                orderBy: jest.fn().mockReturnValue({
                  limit: jest.fn().mockResolvedValue([]),
                }),
              };
            }),
          }),
        })),
      } as unknown as Db,
      wheres,
    };
  }

  it("scopes category list to the requesting org (cross-tenant isolation)", async () => {
    const { db, wheres } = makeDb();
    const svc = new KbCategoriesService(db, access);

    await svc.listBySpace(makeUser(ATTACKER), SPACE_ID);

    expect(wheres.length).toBeGreaterThan(0);
    const vals = wheres.flatMap(w => sqlValues(w));
    expect(vals).toContain(ATTACKER);
    expect(vals).not.toContain(OWNER);
  });

  it("returns categories for the owning org (same-tenant control)", async () => {
    const { db } = makeDb();
    const svc = new KbCategoriesService(db, access);

    const result = await svc.listBySpace(makeUser(OWNER), SPACE_ID);

    expect(Array.isArray(result)).toBe(true);
  });
});
