import { and, eq } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { kbPages } from "../../db/schema";
import { supportArticlePredicate } from "../kb/help-centre/kb-article-page-scope";
import { publicDeliverableDocumentPredicate } from "../kb/core/kb-document-delivery-access";

const dialect = new PgDialect();
const renderedSql = (node: SQL<unknown>): string =>
  dialect.sqlToQuery(node).sql.replace(/\s+/g, " ").trim();
const boundParams = (node: SQL<unknown>): unknown[] => dialect.sqlToQuery(node).params;

const ORG = "org-1";
const SLUG = "article-slug";

function handRolledControllerPredicate(): SQL {
  return and(
    eq(kbPages.orgId, ORG),
    eq(kbPages.slug, SLUG),
    eq(kbPages.status, "published"),
    eq(kbPages.visibility, "public"),
    supportArticlePredicate(),
  ) as SQL;
}

describe("public document delivery — defect: hand-rolled predicate omits restriction check so a restricted public article leaks its attachments to the internet", () => {
  it("the old controller predicate contains no reference to kb_page_restrictions (documents the gap)", () => {
    expect(renderedSql(handRolledControllerPredicate())).not.toContain("kb_page_restrictions");
  });

  it("the old controller predicate does bind visibility=public (shows it is a real predicate, not vacuous)", () => {
    expect(boundParams(handRolledControllerPredicate())).toContain("public");
  });
});

describe("public document delivery — fix: publicDeliverableDocumentPredicate enforces the canonical restriction gate", () => {
  it("includes a kb_page_restrictions NOT EXISTS check so a restricted article is blocked even to anonymous callers", () => {
    expect(renderedSql(publicDeliverableDocumentPredicate(ORG, SLUG))).toContain(
      "kb_page_restrictions",
    );
  });

  it("preserves the status=published gate so unpublished articles remain hidden", () => {
    expect(boundParams(publicDeliverableDocumentPredicate(ORG, SLUG))).toContain("published");
  });

  it("preserves the visibility=public gate so org-only articles are not served publicly (bound param check; 'org' must not be bound)", () => {
    const params = boundParams(publicDeliverableDocumentPredicate(ORG, SLUG));
    expect(params).toContain("public");
    expect(params).not.toContain("org");
  });

  it("preserves the support_article content-type gate so non-help-centre documents are not delivered", () => {
    expect(boundParams(publicDeliverableDocumentPredicate(ORG, SLUG))).toContain("support_article");
  });
});
