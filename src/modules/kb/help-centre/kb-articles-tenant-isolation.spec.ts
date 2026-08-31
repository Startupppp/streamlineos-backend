import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { KbArticlesService } from "./kb-articles.service";

function sqlValues(v: unknown, seen = new Set<object>()): unknown[] {
  if (v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return [v];
  if (Array.isArray(v)) return v.flatMap(i => sqlValues(i, seen));
  if (typeof v !== "object" || seen.has(v)) return [];
  seen.add(v);
  const r = v as { queryChunks?: unknown[]; value?: unknown };
  return [...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []), ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : [])];
}

describe("KbArticlesService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const ARTICLE_ID = 10;

  function makeUser(orgId: string) {
    return { orgId, userId: "user-1", isOrgOwner: false } as never;
  }

  const access = { assertCanViewArticle: jest.fn().mockResolvedValue(undefined) } as never;
  const events = { record: jest.fn().mockResolvedValue(undefined) } as never;

  function makeDb(articleRow: unknown) {
    const wheres: unknown[] = [];
    return {
      db: {
        query: {
          kbArticles: {
            findFirst: jest.fn().mockImplementation((opts: { where?: unknown } = {}) => {
              wheres.push(opts.where);
              return Promise.resolve(articleRow);
            }),
          },
        },
        select: jest.fn().mockImplementation(() => ({
          from: jest.fn().mockReturnValue({
            innerJoin: jest.fn().mockReturnValue({
              where: jest.fn().mockImplementation((w: unknown) => {
                wheres.push(w);
                return Object.assign(Promise.resolve([]), {
                  orderBy: jest.fn().mockResolvedValue([]),
                });
              }),
            }),
          }),
        })),
      } as unknown as Db,
      wheres,
    };
  }

  it("throws NotFoundException for an article in another org (cross-tenant deny)", async () => {
    const { db, wheres } = makeDb(null);
    const svc = new KbArticlesService(db, access, events);

    await expect(svc.get(makeUser(ATTACKER), ARTICLE_ID)).rejects.toThrow(NotFoundException);

    const vals = wheres.flatMap(w => sqlValues(w));
    expect(vals).toContain(ATTACKER);
    expect(vals).not.toContain(OWNER);
  });

  it("returns article for the owning org (same-tenant control)", async () => {
    const articleRow = {
      id: ARTICLE_ID,
      orgId: OWNER,
      title: "Test",
      spaceId: 1,
      category: { id: 1, name: "Cat", slug: "cat" },
    };
    const { db } = makeDb(articleRow);
    const svc = new KbArticlesService(db, access, events);

    const result = await svc.get(makeUser(OWNER), ARTICLE_ID);

    expect(result).toHaveProperty("id", ARTICLE_ID);
  });
});
