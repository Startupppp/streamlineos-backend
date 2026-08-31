import type { Db } from "../../../db/drizzle.module";
import { KbPageReviewsService } from "./kb-page-reviews.service";

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

  const audit = { log: jest.fn() } as never;
  const dispatch = { dispatch: jest.fn() } as never;
  const holdsMock = jest.fn().mockResolvedValue(true);
  const access = { holds: holdsMock } as never;

  function makeDb() {
    const wheres: unknown[] = [];
    const leftJoinChain: Record<string, jest.Mock> = {};
    const makeLeftJoin = (): object => {
      const chain: Record<string, jest.Mock> = {
        where: jest.fn().mockImplementation((w: unknown) => {
          wheres.push(w);
          return Object.assign(Promise.resolve([]), {
            orderBy: jest.fn().mockReturnValue(Object.assign(Promise.resolve([]), { limit: jest.fn().mockResolvedValue([]) })),
          });
        }),
      };
      chain["leftJoin"] = jest.fn().mockImplementation(() => makeLeftJoin());
      return chain;
    };
    return {
      db: {
        select: jest.fn().mockImplementation(() => ({
          from: jest.fn().mockReturnValue(makeLeftJoin()),
        })),
      } as unknown as Db,
      wheres,
    };
  }

  afterEach(() => jest.resetAllMocks());

  it("scopes review list query to the requesting org (cross-tenant isolation)", async () => {
    const { db, wheres } = makeDb();
    holdsMock.mockResolvedValue(true);
    const svc = new KbPageReviewsService(db, audit, dispatch, access);

    await svc.list(makeUser(ATTACKER), undefined, undefined);

    expect(wheres.length).toBeGreaterThan(0);
    const vals = wheres.flatMap(w => sqlValues(w));
    expect(vals).toContain(ATTACKER);
    expect(vals).not.toContain(OWNER);
  });

  it("returns reviews for the owning org (same-tenant control)", async () => {
    const { db } = makeDb();
    holdsMock.mockResolvedValue(true);
    const svc = new KbPageReviewsService(db, audit, dispatch, access);

    const result = await svc.list(makeUser(OWNER), undefined, undefined);

    expect(Array.isArray(result)).toBe(true);
  });
});
