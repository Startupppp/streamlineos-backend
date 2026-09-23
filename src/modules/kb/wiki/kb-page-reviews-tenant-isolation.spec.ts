import { sql } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import { KbPageReviewsQueryService } from "./kb-page-reviews-query.service";

function sqlValues(v: unknown, seen = new Set<object>()): unknown[] {
  if (v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return [v];
  if (Array.isArray(v)) return v.flatMap(i => sqlValues(i, seen));
  if (typeof v !== "object" || seen.has(v)) return [];
  seen.add(v);
  const r = v as { queryChunks?: unknown[]; value?: unknown };
  return [...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []), ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : [])];
}

describe("KbPageReviewsService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  function makeUser(orgId: string) {
    return {
      orgId,
      userId: "user-1",
      isOrgOwner: false,
      principal: { kind: "human-session", membershipId: 1 },
    } as never;
  }

  const holdsMock = jest.fn().mockResolvedValue(true);
  const access = { holds: holdsMock } as never;
  const auth = {
    visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
    assertPageAccess: jest.fn().mockResolvedValue({ orgId: "org-1", pageId: 1, action: "view", via: "admin" }),
  };

  function makeDb() {
    const wheres: unknown[] = [];
    const makeChain = (): object => {
      const chain: Record<string, jest.Mock> = {
        where: jest.fn().mockImplementation((w: unknown) => {
          wheres.push(w);
          const tailChain = {
            orderBy: jest.fn().mockImplementation(() =>
              Object.assign(Promise.resolve([]), {
                limit: jest.fn().mockResolvedValue([]),
              }),
            ),
          };
          return tailChain;
        }),
      };
      for (const m of ["innerJoin", "leftJoin"]) {
        chain[m] = jest.fn().mockImplementation(() => makeChain());
      }
      return chain;
    };
    return {
      db: {
        select: jest.fn().mockImplementation(() => ({
          from: jest.fn().mockReturnValue(makeChain()),
        })),
      } as unknown as Db,
      wheres,
    };
  }

  afterEach(() => jest.resetAllMocks());

  it("scopes review list query to the requesting org (cross-tenant isolation)", async () => {
    const { db, wheres } = makeDb();
    holdsMock.mockResolvedValue(true);
    const svc = new KbPageReviewsQueryService(db, access, auth as never);

    await svc.list(makeUser(ATTACKER), { limit: 50, sortDir: "asc" });

    expect(wheres.length).toBeGreaterThan(0);
    const vals = wheres.flatMap(w => sqlValues(w));
    expect(vals).toContain(ATTACKER);
    expect(vals).not.toContain(OWNER);
  });

  it("returns a cursor page for the owning org (same-tenant control)", async () => {
    const { db } = makeDb();
    holdsMock.mockResolvedValue(true);
    const svc = new KbPageReviewsQueryService(db, access, auth as never);

    const result = await svc.list(makeUser(OWNER), { limit: 50, sortDir: "asc" });

    expect(result).toMatchObject({ data: expect.any(Array), pagination: expect.any(Object) });
  });
});
