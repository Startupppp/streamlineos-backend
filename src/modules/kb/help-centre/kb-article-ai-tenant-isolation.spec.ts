import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { KbArticleAiService } from "./kb-article-ai.service";

function sqlValues(v: unknown, seen = new Set<object>()): unknown[] {
  if (v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return [v];
  if (Array.isArray(v)) return v.flatMap(i => sqlValues(i, seen));
  if (typeof v !== "object" || seen.has(v)) return [];
  seen.add(v);
  const r = v as { queryChunks?: unknown[]; value?: unknown };
  return [...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []), ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : [])];
}

describe("KbArticleAiService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const ARTICLE_ID = 11;

  function makeUser(orgId: string) {
    return { orgId, userId: "user-1", isOrgOwner: false } as never;
  }

  const access = { assertCanViewArticle: jest.fn().mockResolvedValue(undefined) } as never;
  const gateway = {
    invokeTextWithUsage: jest.fn().mockResolvedValue({ ok: true, data: "summary", aiUsage: undefined }),
  } as never;
  const audit = { log: jest.fn() } as never;

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
      } as unknown as Db,
      wheres,
    };
  }

  it("throws NotFoundException for an article in another org (cross-tenant deny)", async () => {
    const { db, wheres } = makeDb(null);
    const svc = new KbArticleAiService(db, access, gateway, audit);

    await expect(svc.summarize(makeUser(ATTACKER), ARTICLE_ID)).rejects.toThrow(NotFoundException);

    const vals = wheres.flatMap(w => sqlValues(w));
    expect(vals).toContain(ATTACKER);
    expect(vals).not.toContain(OWNER);
  });

  it("returns summary for an article in the owning org (same-tenant control)", async () => {
    const { db } = makeDb({ id: ARTICLE_ID, orgId: OWNER, title: "Test", contentText: "content", spaceId: 1 });
    const svc = new KbArticleAiService(db, access, gateway, audit);

    const result = await svc.summarize(makeUser(OWNER), ARTICLE_ID);

    expect(result).toHaveProperty("text");
  });
});
