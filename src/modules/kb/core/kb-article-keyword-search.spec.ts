import { humanSessionPrincipal } from "../../../common/auth/principal";
import { ScopedRead } from "../../access/scoped-read";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import { KbArticleQueryService } from "../help-centre/kb-article-query.service";
import type { KbAccessService } from "./kb-access.service";
import { articleTsquery, resolveArticleKeywordSql } from "./kb-article-keyword-search";

const dialect = new PgDialect();

function makeDb(executeRows: Array<Record<string, unknown>>) {
  const execute = jest.fn().mockResolvedValue(executeRows);
  return { execute } as unknown as Db & { execute: jest.Mock };
}

describe("article keyword search has one plan", () => {
  it("resolves to an id list from app.search_kb_article_ids when the term is selective", async () => {
    const db = makeDb([{ id: 7 }, { id: 9 }]);
    const cond = await resolveArticleKeywordSql(db, "onboarding", articleTsquery("onboarding"), 500);
    const { sql: text, params } = dialect.sqlToQuery(cond);

    expect(db.execute).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(db.execute.mock.calls[0])).toContain("app.search_kb_article_ids");
    expect(text).toContain('"kb_articles"."id" in');
    expect(params).toEqual([7, 9]);
    expect(text).not.toContain("ilike");
  });

  it("falls back to the fts predicate — never a bare leading-wildcard ilike — when the term is too broad", async () => {
    const rows = Array.from({ length: 501 }, (_, i) => ({ id: i + 1 }));
    const db = makeDb(rows);
    const cond = await resolveArticleKeywordSql(db, "the", articleTsquery("the"), 500);
    const { sql: text } = dialect.sqlToQuery(cond);

    expect(text).toContain("fts @@");
    expect(text).toContain("numnode(");
  });

  it("guards the ilike arm behind an empty tsquery so it can never run on a real term", async () => {
    const db = makeDb([]);
    const cond = await resolveArticleKeywordSql(db, "policy", articleTsquery("policy"), 500);
    const { sql: text } = dialect.sqlToQuery(cond);
    const ilikeAt = text.indexOf("ilike");
    const numnodeAt = text.indexOf("numnode(");

    expect(ilikeAt).toBeGreaterThan(-1);
    expect(numnodeAt).toBeGreaterThan(-1);
    expect(numnodeAt).toBeLessThan(ilikeAt);
  });
});

describe("KbArticleQueryService.list shares that plan", () => {
  function makeService(executeRows: Array<Record<string, unknown>>) {
    const captured: { where?: SQL } = {};
    const chain: Record<string, jest.Mock> = {
      from: jest.fn(),
      where: jest.fn(),
      orderBy: jest.fn(),
      limit: jest.fn(),
    };
    chain["from"].mockReturnValue(chain);
    chain["where"].mockImplementation((cond: SQL) => {
      captured.where = cond;
      return chain;
    });
    chain["orderBy"].mockReturnValue(chain);
    chain["limit"].mockResolvedValue([]);
    const execute = jest.fn().mockResolvedValue(executeRows);
    const db = { select: jest.fn().mockReturnValue(chain), execute } as unknown as Db;
    const access = {
      getAccessibleSpaceIds: jest.fn().mockResolvedValue([1]),
    } as unknown as KbAccessService;
    return { svc: new KbArticleQueryService(db, access), captured, execute };
  }

  const ORG = "org-1";
  const USER = "user-1";
  const user = { orgId: ORG, userId: USER, principal: humanSessionPrincipal(1, false) } as never;
  const query = { limit: 20, search: "onboarding" } as never;

  it("routes ?search= through app.search_kb_article_ids rather than a leading-wildcard ilike", async () => {
    const { svc, captured, execute } = makeService([{ id: 7 }]);
    await svc.list(user, query, ScopedRead.of(ORG, USER, "all"));

    expect(execute).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(execute.mock.calls[0])).toContain("app.search_kb_article_ids");
    const { sql: text, params } = dialect.sqlToQuery(captured.where as SQL);
    expect(text).not.toContain("ilike");
    expect(params).not.toContain("%onboarding%");
    expect(params).toContain(7);
  });

  it("agrees with the search endpoint's condition for the same term and cap", async () => {
    const { svc, captured } = makeService([{ id: 7 }, { id: 12 }]);
    await svc.list(user, query, ScopedRead.of(ORG, USER, "all"));
    const listText = dialect.sqlToQuery(captured.where as SQL).sql;

    const searchCond = await resolveArticleKeywordSql(
      makeDb([{ id: 7 }, { id: 12 }]),
      "onboarding",
      articleTsquery("onboarding"),
      500,
    );
    const unnumbered = (text: string) => text.replace(/\$\d+/g, "$?");
    expect(unnumbered(listText)).toContain(unnumbered(dialect.sqlToQuery(searchCond).sql));
  });
});
