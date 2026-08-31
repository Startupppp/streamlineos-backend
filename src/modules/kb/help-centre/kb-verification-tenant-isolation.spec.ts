import type { Db } from "../../../db/drizzle.module";
import { KbVerificationService } from "./kb-verification.service";

function sqlValues(v: unknown, seen = new Set<object>()): unknown[] {
  if (v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return [v];
  if (Array.isArray(v)) return v.flatMap(i => sqlValues(i, seen));
  if (typeof v !== "object" || seen.has(v)) return [];
  seen.add(v);
  const r = v as { queryChunks?: unknown[]; value?: unknown };
  return [...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []), ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : [])];
}

describe("KbVerificationService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  function makeUser(orgId: string) {
    return { orgId, userId: "user-1", isOrgOwner: false } as never;
  }

  const access = { getAccessibleSpaceIds: jest.fn().mockResolvedValue([1, 2]) } as never;

  function makeDb() {
    const wheres: unknown[] = [];
    return {
      db: {
        select: jest.fn().mockImplementation(() => ({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockImplementation((w: unknown) => {
              wheres.push(w);
              return Object.assign(Promise.resolve([]), {
                orderBy: jest.fn().mockReturnValue(
                  Object.assign(Promise.resolve([]), {
                    limit: jest.fn().mockReturnValue(
                      Object.assign(Promise.resolve([]), {
                        offset: jest.fn().mockResolvedValue([]),
                      }),
                    ),
                  }),
                ),
              });
            }),
          }),
        })),
      } as unknown as Db,
      wheres,
    };
  }

  it("scopes verification queue to the requesting org (cross-tenant isolation)", async () => {
    const { db, wheres } = makeDb();
    const svc = new KbVerificationService(db, access);

    await svc.listDue(makeUser(ATTACKER), 1, 20);

    expect(wheres.length).toBeGreaterThan(0);
    const vals = wheres.flatMap(w => sqlValues(w));
    expect(vals).toContain(ATTACKER);
    expect(vals).not.toContain(OWNER);
  });

  it("returns verification queue for the owning org (same-tenant control)", async () => {
    const { db } = makeDb();
    const svc = new KbVerificationService(db, access);

    const result = await svc.listDue(makeUser(OWNER), 1, 20);

    expect(result).toHaveProperty("items");
  });
});
