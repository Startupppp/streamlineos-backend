import { NotFoundException } from "@nestjs/common";
import type { SQL } from "drizzle-orm";
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

  function makeDb(results: unknown[][]) {
    const wheres: SQL[] = [];
    const queue = [...results];
    const select = jest.fn(() => {
      const rows = queue.shift() ?? [];
      const node: Record<string, unknown> = {};
      const self = (): unknown => node;
      node.from = self;
      node.leftJoin = self;
      node.innerJoin = self;
      node.orderBy = self;
      node.limit = self;
      node.where = (w: SQL): unknown => {
        wheres.push(w);
        return node;
      };
      node.then = (resolve: (value: unknown[]) => unknown): Promise<unknown> =>
        Promise.resolve(rows).then(resolve);
      return node;
    });
    return { db: { select } as unknown as Db, wheres };
  }

  const PAGE_ROW = {
    id: ARTICLE_ID,
    orgId: OWNER,
    spaceId: 1,
    categoryId: 1,
    title: "Test",
    slug: "test",
    excerpt: null,
    content: null,
    contentText: "",
    status: "published",
    visibility: "org",
    createdById: "user-1",
    ownerMembershipId: null,
    trustState: "unverified",
    verifiedUntil: null,
    views: 0,
    helpfulCount: 0,
    notHelpfulCount: 0,
    seoTitle: null,
    seoDescription: null,
    reviewIntervalDays: null,
    publishedAt: null,
    archivedAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    aclRevision: 1,
    contentRevision: 1,
    categoryName: "Cat",
    categorySlug: "cat",
  };

  it("throws NotFoundException for an article in another org (cross-tenant deny)", async () => {
    const { db, wheres } = makeDb([[]]);
    const svc = new KbArticlesService(db, access, events);

    await expect(svc.get(makeUser(ATTACKER), ARTICLE_ID)).rejects.toThrow(NotFoundException);

    const vals = wheres.flatMap(w => sqlValues(w));
    expect(vals).toContain(ATTACKER);
    expect(vals).not.toContain(OWNER);
  });

  it("returns article for the owning org (same-tenant control)", async () => {
    const { db } = makeDb([[PAGE_ROW], []]);
    const svc = new KbArticlesService(db, access, events);

    const result = await svc.get(makeUser(OWNER), ARTICLE_ID);

    expect(result).toHaveProperty("id", ARTICLE_ID);
    expect(result.category).toEqual({ id: 1, name: "Cat", slug: "cat" });
  });
});
