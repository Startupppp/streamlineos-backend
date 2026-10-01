import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { overviewQuerySchema } from "./dto/kb-analytics.schemas";
import { pageScopePredicate } from "./kb-article-page-scope";

const dialect = new PgDialect();

function render(where: SQL): string {
  return dialect.sqlToQuery(where).sql;
}

describe("one analytics overview route serves both the wiki page and the help centre tab, so its page scope has to be explicit", () => {
  it("defaults to support articles, so the help centre tab keeps the numbers it returned before a wiki scope existed", () => {
    expect(overviewQuerySchema.parse({}).scope).toBe("support");
  });

  it("accepts the wiki scope that the wiki analytics page sends", () => {
    expect(overviewQuerySchema.parse({ scope: "wiki" }).scope).toBe("wiki");
  });

  it("rejects an unknown scope rather than silently serving one surface the other surface's numbers", () => {
    expect(overviewQuerySchema.safeParse({ scope: "everything" }).success).toBe(false);
  });

  it("counts only support articles under the support scope", () => {
    const sql = render(pageScopePredicate("support"));
    expect(sql).toContain("content_type");
    expect(sql).not.toContain("<>");
  });

  it("counts every non-support page under the wiki scope, which is what the overview was never doing for wiki pages", () => {
    const sql = render(pageScopePredicate("wiki"));
    expect(sql).toContain("content_type");
    expect(sql).toContain("<>");
  });

  it("excludes soft-deleted pages under both scopes", () => {
    expect(render(pageScopePredicate("support"))).toContain("deleted_at");
    expect(render(pageScopePredicate("wiki"))).toContain("deleted_at");
  });
});
